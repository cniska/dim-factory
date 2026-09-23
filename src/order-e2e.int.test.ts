import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db";
import { claimOrder, queueOrder } from "./factory-order";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { collectingMachine, integratedRepo } from "./fixtures.test-support";
import { runOrderCommand, runOrderCommandLive } from "./order-command";
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

const brief = Bun.argv.find((arg) => arg.includes("factory order ")) ?? "";
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

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");

emit({ type: "thread.started", thread_id: "harness-" + role + "-" + order });
emit({ type: "turn.started" });
if (brief.includes("planner")) {
  emit({ type: "item.completed", item: { type: "agent_message", text: "## Outcome\\n\\nBuild the requested result." } });
} else if (brief.includes("builder")) {
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
  // The harness emits its terminal event after the station work returns.
} else {
  process.exit(4);
}
emit({ type: "turn.completed" });
`;
}

describe("headless factory loop", () => {
  test("runs an order through real configured station processes", async () => {
    const repo = integratedRepo();
    const machine = collectingMachine();
    roots.push(repo.dir, machine.dir);
    mkdirSync(machine.env.DIM_HOME as string, { recursive: true });
    writeFileSync(
      join(machine.env.DIM_HOME as string, "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const bin = join(machine.dir, "bin");
    mkdirSync(bin);
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/usr/bin/env bun\n${harness(join(import.meta.dir, "cli.ts"))}`);
    chmodSync(fakeCodex, 0o755);
    machine.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

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

    expect(
      await runOrderCommandLive(db, ["plan", "headless-order", "--harness", "codex"], null, repo.dir, env),
    ).toContain("## Outcome");
    expect(runOrderCommand(db, ["approve", "headless-order"], null, repo.dir, env)).toContain(
      "plan approved",
    );
    expect(
      runOrderCommand(db, ["move", "headless-order", "--station", "dim-station-build"], null, repo.dir, env),
    ).toContain("moved");
    expect(
      await runOrderCommandLive(db, ["build", "headless-order", "--harness", "codex"], null, repo.dir, env),
    ).toContain("build completed by");

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
    expect(
      await runOrderCommandLive(db, ["review", "headless-order", "--harness", "codex"], null, repo.dir, env),
    ).toContain("0 findings");
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
    expect(
      db
        .query<{ role: string; worker: string; provider_session_id: string }, [string]>(
          `SELECT w.role, ow.worker, ow.provider_session_id
           FROM factory_order_worker ow
           JOIN factory_worker w ON w.name = ow.worker
           WHERE ow.order_id = ? ORDER BY w.role`,
        )
        .all("headless-order"),
    ).toEqual([
      { role: "builder", worker: expect.any(String), provider_session_id: "harness-builder-headless-order" },
      { role: "planner", worker: expect.any(String), provider_session_id: "harness-planner-headless-order" },
      {
        role: "reviewer",
        worker: expect.any(String),
        provider_session_id: "harness-reviewer-headless-order",
      },
    ]);
    expect(
      db
        .query<{ role: string; n: number; ended: number }, [string]>(
          `SELECT w.role, count(*) AS n, count(w.ended_at) AS ended
           FROM factory_order_worker ow
           JOIN factory_worker w ON w.name = ow.worker
           WHERE ow.order_id = ? GROUP BY w.role ORDER BY w.role`,
        )
        .all("headless-order"),
    ).toEqual([
      { role: "builder", n: 1, ended: 0 },
      { role: "planner", n: 1, ended: 0 },
      { role: "reviewer", n: 1, ended: 0 },
    ]);
    db.close();
  });
});
