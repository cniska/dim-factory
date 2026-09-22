import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db";
import { claimOrder, queueOrder } from "./factory-order";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { collectingMachine, integratedRepo } from "./fixtures.test-support";
import { runOrderCommand } from "./order-command";
import { dbPath, type Env } from "./paths";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workerEnv(machine: Env, worker: { name: string; token: string; sessionId: string }): Env {
  return {
    ...machine,
    [WORKER_NAME_VAR]: worker.name,
    [WORKER_TOKEN_VAR]: worker.token,
    [WORKER_SESSION_VAR]: worker.sessionId,
  };
}

function harness(cli: string): string {
  return `
import { writeFileSync } from "node:fs";

const brief = Bun.argv[2] ?? "";
const cli = ${JSON.stringify(cli)};
const order = /factory order ([^\\s]+)/.exec(brief)?.[1];
if (!order) process.exit(2);
const role = brief.includes("planner") ? "planner" : brief.includes("builder") ? "builder" : "reviewer";
const childEnv = { ...process.env, DIM_SESSION_ID: \`harness-\${role}-\${order}\` };

function run(args) {
  const result = Bun.spawnSync(["bun", cli, "order", ...args], {
    cwd: process.cwd(),
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    console.error(result.stdout.toString(), result.stderr.toString());
    process.exit(result.exitCode ?? 1);
  }
}

if (process.env.DIM_WORKER_ASSIGNMENT_ID) {
  const bootstrapped = Bun.spawnSync(["bun", cli, "worker", "bootstrap", process.env.DIM_WORKER_ASSIGNMENT_ID], {
    cwd: process.cwd(),
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!bootstrapped.success) {
    console.error(bootstrapped.stdout.toString(), bootstrapped.stderr.toString());
    process.exit(bootstrapped.exitCode ?? 1);
  }
  for (const line of bootstrapped.stdout.toString().trim().split("\\n")) {
    const [name, value] = line.replace("export ", "").split("=");
    if (name && value) childEnv[name] = value;
  }
}

if (brief.includes("planner")) {
  console.log("## Outcome\\n\\nBuild the requested result.");
} else if (brief.includes("builder")) {
  const runId = /--run ([^\\s]+)/.exec(brief)?.[1];
  if (!runId) process.exit(3);
  run(["claim", order, "--run", runId, "--station", "dim-station-build"]);
  writeFileSync("built-by-real-harness.txt", "built\\n");
  for (const args of [
    ["add", "built-by-real-harness.txt"],
    ["commit", "-m", "feat: real harness build"],
  ]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    if (!result.success) process.exit(result.exitCode ?? 1);
  }
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: process.cwd(), stdout: "pipe" }).stdout.toString().trim();
  run(["commit", order, "--sha", sha, "--subject", "feat: real harness build"]);
  run(["file", order, "--path", "built-by-real-harness.txt", "--added", "1", "--removed", "0"]);
  run(["check", order, "--command", "true", "--exit", "0", "--result", "green"]);
} else if (brief.includes("reviewer")) {
  process.exit(0);
} else {
  process.exit(4);
}
`;
}

describe("headless factory loop", () => {
  test("runs an order through real configured station processes", () => {
    const repo = integratedRepo();
    const machine = collectingMachine();
    roots.push(repo.dir, machine.dir);
    mkdirSync(machine.env.DIM_HOME as string, { recursive: true });
    writeFileSync(
      join(machine.env.DIM_HOME as string, "routing.json"),
      '{ "cheap": "small", "standard": "middling", "deep": "large" }',
    );
    writeFileSync(
      join(machine.env.DIM_HOME as string, "spawn.json"),
      JSON.stringify({
        argv: ["bun", join(machine.dir, "harness.ts"), "{brief}", "{model}", "{tools}"],
        slots: { tools: { join: "," } },
        grants: {
          "bootstrap-worker": { tools: ["Bash(dim worker bootstrap:*)"] },
          "read-files": { tools: ["Read"] },
          "edit-files": { tools: ["Edit"] },
          "read-history": { tools: ["Bash(git log:*)"] },
          "ask-dim": { tools: ["Bash(dim q:*)"] },
          "run-check": { tools: ["Bash(true:*)"] },
          "raise-finding": { tools: ["Bash(dim order finding:*)"] },
        },
      }),
    );
    writeFileSync(join(machine.dir, "harness.ts"), harness(join(import.meta.dir, "cli.ts")));

    const db = openDb(dbPath(machine.env));
    const operator = mintWorker(db, { role: "operator", sessionId: "e2e-operator" });
    const env = workerEnv(machine.env, operator);
    queueOrder(
      db,
      { id: "headless-order", project: "cniska/dim-factory", title: "Run end to end" },
      operator.name,
    );
    claimOrder(
      db,
      "headless-order",
      { runId: "plan-run", station: "dim-station-plan", sessionId: operator.sessionId },
      operator.name,
      undefined,
      repo.dir,
    );

    expect(runOrderCommand(db, ["plan", "headless-order"], null, repo.dir, env)).toContain("## Outcome");
    expect(runOrderCommand(db, ["approve", "headless-order"], null, repo.dir, env)).toContain(
      "plan approved",
    );
    expect(
      runOrderCommand(db, ["move", "headless-order", "--station", "dim-station-build"], null, repo.dir, env),
    ).toContain("moved");
    expect(runOrderCommand(db, ["build", "headless-order"], null, repo.dir, env)).toContain(
      "building started",
    );

    const worktree = join(repo.dir, ".claude", "worktrees", "headless-order");
    expect(existsSync(join(worktree, "built-by-real-harness.txt"))).toBe(true);
    expect(
      runOrderCommand(
        db,
        ["approve-build", "headless-order", "--reason", "the artifact is present"],
        null,
        repo.dir,
        env,
      ),
    ).toContain("build approved");
    runOrderCommand(db, ["move", "headless-order", "--station", "dim-station-review"], null, repo.dir, env);
    expect(runOrderCommand(db, ["review", "headless-order"], null, worktree, env)).toContain("0 findings");
    expect(runOrderCommand(db, ["approve-review", "headless-order"], null, repo.dir, env)).toContain(
      "review approved",
    );
    expect(runOrderCommand(db, ["ship", "headless-order"], null, repo.dir, env)).toContain("fast-forwarded");
    expect(runOrderCommand(db, ["stop", "headless-order", "completed"], null, repo.dir, env)).toContain(
      "completed",
    );

    expect(db.query("SELECT status FROM factory_order WHERE id = ?").get("headless-order")).toEqual({
      status: "completed",
    });
    expect(
      db
        .query<{ kind: string }, [string]>("SELECT kind FROM factory_order_event WHERE order_id = ?")
        .all("headless-order")
        .map((row) => row.kind),
    ).toEqual([
      "queued",
      "claimed",
      "plan_submitted",
      "plan_approved",
      "moved",
      "claimed",
      "commit_created",
      "check_finished",
      "build_approved",
      "moved",
      "review_opened",
      "review_closed",
      "review_approved",
      "completed",
    ]);
    expect(
      db.query("SELECT worker, path FROM factory_order_file WHERE order_id = ?").get("headless-order"),
    ).toEqual({
      worker: expect.any(String),
      path: "built-by-real-harness.txt",
    });
    db.close();
  });
});
