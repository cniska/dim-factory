import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db";
import { claimOrder, queueOrder } from "./factory-order";
import { mintWorker, WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { collectingMachine, declareCheck, integratedRepo } from "./fixtures.test-support";
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

function harness(): string {
  return `
import { writeFileSync } from "node:fs";

// The runner's check sandbox is \`codex sandbox ... -- <command>\`; this stands in for it by refusing
// the canary write and running the check unconfined.
if (Bun.argv[2] === "sandbox") {
  const command = Bun.argv.slice(Bun.argv.indexOf("--") + 1);
  if (command.join(" ").includes("check-canary-")) process.exit(1);
  process.exit(Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" }).exitCode ?? 1);
}

const brief = Bun.argv.find((arg) => arg.includes("factory order ")) ?? "";
const order = /factory order ([^\\s]+)/.exec(brief)?.[1];
if (!order) process.exit(2);
const role = brief.includes("planner") ? "planner" : brief.includes("builder") ? "builder" : "reviewer";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");

emit({ type: "thread.started", thread_id: "harness-" + role + "-" + order });
emit({ type: "turn.started" });
if (brief.includes("planner")) {
  emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ body: "## Outcome\\n\\nBuild the requested result.", slices: [{ title: "First slice", outcome: "The first slice is verified." }, { title: "Second slice", outcome: "The second slice is verified." }] }) } });
} else if (brief.includes("builder")) {
  const slice = /# Current slice\\s+(\\d+)\\./.exec(brief)?.[1] ?? "1";
  const file = "built-by-real-harness-" + slice + ".txt";
  writeFileSync(file, "slice " + slice + "\\n");
  const artifact = slice === "2" ? ${JSON.stringify("## Outcome\n\nThe requested queue flow is implemented across both slices.\n\n## Implementation\n\nThe factory now selects and reserves one ready order under its lock.\n\n## Why this shape\n\nReservation reuses the existing claim boundary, so selection and ownership cannot diverge.\n\n## Verification\n\nBoth slices recorded passing checks, and the final harness run completed successfully.\n\n## Owner attention\n\nThe wall remains outside this order.")} : "";
  emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ subject: "feat: real harness slice " + slice, artifact }) } });
} else if (brief.includes("reviewer")) {
  emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ body: "## Outcome\\n\\nNo findings; the change is ready to advance.", findings: [] }) } });
} else {
  process.exit(4);
}
emit({ type: "turn.completed" });
`;
}

describe("headless factory loop", () => {
  test("runs an order through real configured station processes", async () => {
    const repo = integratedRepo();
    const base = declareCheck(repo.dir);
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
    writeFileSync(fakeCodex, `#!/usr/bin/env bun\n${harness()}`);
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
      {
        runId: "plan-run",
        station: "dim-station-plan",
        sessionId: operator.sessionId,
        operatorWorker: operator.name,
      },
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
    expect(existsSync(join(worktree, "built-by-real-harness-1.txt"))).toBe(true);
    runOrderCommand(db, ["move", "headless-order", "--station", "dim-station-review"], null, repo.dir, env);
    expect(
      await runOrderCommandLive(db, ["review", "headless-order", "--harness", "codex"], null, repo.dir, env),
    ).toContain("0 findings");
    expect(
      runOrderCommand(db, ["move", "headless-order", "--station", "dim-station-build"], null, repo.dir, env),
    ).toContain("moved");
    expect(
      await runOrderCommandLive(db, ["build", "headless-order", "--harness", "codex"], null, repo.dir, env),
    ).toContain("build completed by");
    expect(existsSync(join(worktree, "built-by-real-harness-2.txt"))).toBe(true);
    expect(
      runOrderCommand(
        db,
        ["approve", "headless-order", "--reason", "the complete build artifact is present"],
        null,
        repo.dir,
        env,
      ),
    ).toContain("build approved");
    runOrderCommand(db, ["move", "headless-order", "--station", "dim-station-review"], null, repo.dir, env);
    expect(
      await runOrderCommandLive(db, ["review", "headless-order", "--harness", "codex"], null, repo.dir, env),
    ).toContain("0 findings");
    expect(runOrderCommand(db, ["approve", "headless-order"], null, repo.dir, env)).toContain(
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
      "plan_artifact_written",
      "hold_set",
      "owner_verdict_recorded",
      "plan_approved",
      "hold_released",
      "moved",
      "claimed",
      "commit_created",
      "check_finished",
      "moved",
      "review_opened",
      "review_artifact_written",
      "review_closed",
      "moved",
      "claimed",
      "commit_created",
      "check_finished",
      "build_artifact_written",
      "hold_set",
      "owner_verdict_recorded",
      "build_approved",
      "hold_released",
      "moved",
      "review_opened",
      "review_artifact_written",
      "review_closed",
      "hold_set",
      "owner_verdict_recorded",
      "review_approved",
      "hold_released",
      "integration_recorded",
      "delivery_recorded",
      "completed",
    ]);
    expect(
      db
        .query("SELECT body FROM factory_order_review_artifact WHERE order_id = ? ORDER BY id")
        .all("headless-order"),
    ).toEqual([
      { body: "## Outcome\n\nNo findings; the change is ready to advance." },
      { body: "## Outcome\n\nNo findings; the change is ready to advance." },
    ]);
    expect(
      db
        .query<{ worker: string; path: string }, [string]>(
          "SELECT worker, path FROM factory_order_file WHERE order_id = ? ORDER BY path",
        )
        .all("headless-order"),
    ).toEqual([
      { worker: expect.any(String), path: "built-by-real-harness-1.txt" },
      { worker: expect.any(String), path: "built-by-real-harness-2.txt" },
    ]);
    expect(
      db
        .query<{ body: string; head_sha: string }, [string]>(
          "SELECT body, head_sha FROM factory_order_build WHERE order_id = ?",
        )
        .all("headless-order"),
    ).toEqual([
      {
        body: expect.stringContaining("## Outcome"),
        head_sha: expect.any(String),
      },
    ]);
    expect(
      db
        .query<{ ordinal: number; worker: string }, [string]>(
          `SELECT s.ordinal, c.worker
           FROM factory_order_slice_completion c
           JOIN factory_order_slice s ON s.id = c.slice_id
           JOIN factory_order_plan p ON p.id = s.plan_id
           WHERE p.order_id = ? ORDER BY s.ordinal`,
        )
        .all("headless-order"),
    ).toEqual([
      { ordinal: 1, worker: expect.any(String) },
      { ordinal: 2, worker: expect.any(String) },
    ]);
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
        .query<{ role: string; n: number; pids: number; ended: number }, [string]>(
          `SELECT w.role, count(*) AS n, count(w.pid) AS pids, count(w.ended_at) AS ended
           FROM factory_order_worker ow
           JOIN factory_worker w ON w.name = ow.worker
           WHERE ow.order_id = ? GROUP BY w.role ORDER BY w.role`,
        )
        .all("headless-order"),
    ).toEqual([
      { role: "builder", n: 1, pids: 1, ended: 1 },
      { role: "planner", n: 1, pids: 1, ended: 1 },
      { role: "reviewer", n: 1, pids: 1, ended: 1 },
    ]);

    const builder = db
      .query<{ worker: string }, [string]>(
        "SELECT worker FROM factory_order_worker WHERE order_id = ? AND role = 'builder'",
      )
      .get("headless-order")?.worker;
    const git = (args: string[]) =>
      Bun.spawnSync(["git", "-C", repo.dir, ...args], { stdout: "pipe", stderr: "pipe" });
    const landed = git(["rev-list", "--reverse", `${base}..main`])
      .stdout.toString()
      .trim()
      .split("\n");
    expect(landed).toHaveLength(2);
    expect(git(["rev-list", "--merges", "--count", "main"]).stdout.toString().trim()).toBe("0");
    for (const sha of landed) {
      expect(git(["verify-commit", sha]).success).toBe(true);
      expect(git(["log", "-1", "--format=%an <%ae>", sha]).stdout.toString().trim()).toBe(
        "Test <t@example.com>",
      );
    }
    expect(
      db
        .query<{ worker: string }, [string]>(
          "SELECT DISTINCT worker FROM factory_order_event WHERE order_id = ? AND kind = 'commit_created'",
        )
        .all("headless-order"),
    ).toEqual([{ worker: builder ?? "" }]);
    expect(
      db
        .query<{ worker: string }, [string]>(
          "SELECT DISTINCT worker FROM factory_order_event WHERE order_id = ? AND kind = 'check_finished'",
        )
        .all("headless-order"),
    ).toEqual([{ worker: operator.name }]);
    db.close();
  });
});
