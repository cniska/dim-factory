import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./cli-contract";
import { SCHEMA_SQL } from "./db-schema";
import {
  attemptIn,
  collectingMachine,
  integratedRepo,
  ranCheck,
  reviewIn,
  scratchEnv,
} from "./fixtures.test-support";
import { hookConfigPath } from "./hooks";
import { TOOLS } from "./ingest-tools";
import { orderState } from "./order";
import { completeOrderSlice, nextOrderSlice, recordOrderBuild, recordOrderPlan } from "./order-artifacts";
import { runOrderCommand as runCommand, runOrderCommandLive, runRemainingBuilds } from "./order-command";
import { recordOrderCheck, recordOrderCommit } from "./order-evidence";
import { appendOrderEvent } from "./order-ledger";
import { startOrder } from "./order-lifecycle";
import { closeOrderReview, recordOrderReviewArtifact } from "./order-review";
import { orderStatus } from "./order-status";
import type { Env } from "./paths";
import { findQuery } from "./query-registry";
import { approveFinalBuildAt, approvePlan, approveReviewAt } from "./station-approvals.test-support";
import { ensureOrderWorker, releaseOrderWorker } from "./station-worker";
import { assembleWallSnapshot } from "./wall/server";
import { mintWorker, newWorkerSession, resolveWorker as resolveFromAncestry } from "./worker";
import { bootstrapWorker } from "./worker-assignment";
import { WORKER_NAME_VAR } from "./worker-name";

const opened: Database[] = [];

let env: Env = {};

const machine = collectingMachine();

function db(): Database {
  const database = new Database(":memory:");
  database.run(SCHEMA_SQL);
  const operator = mintWorker(database, {
    role: "operator",
    pid: process.ppid,
    sessionId: newWorkerSession("test-operator"),
  });
  env = { ...machine.env, [WORKER_NAME_VAR]: operator.name };
  opened.push(database);
  return database;
}

function resolveWorker(database: Database, _env?: Env): string {
  return resolveFromAncestry(database);
}

function runOrderCommand(
  database: Database,
  args: string[],
  project: string | null = null,
  cwd: string = trunk.dir,
  as: Env = env,
): string {
  return runCommand(database, args, project, cwd, as) as string;
}

const trunk = integratedRepo();
afterAll(() => {
  for (const database of opened) database.close();
  rmSync(trunk.dir, { recursive: true, force: true });
  rmSync(machine.dir, { recursive: true, force: true });
});

function landed(database: Database, orderId: string): void {
  const operator = resolveWorker(database, env);
  recordOrderCommit(database, orderId, trunk.sha, operator, "feat: land it");
  recordOrderCheck(database, orderId, ranCheck({ command: "bun run verify", exitCode: 0 }), trunk.sha);
}

const add = [
  "add",
  "order-1",
  "--title",
  "Record a factory order as work is taken",
  "--description",
  "The record holds what an order is called and never what it says.",
  "--line",
  "fix",
  "--project",
  "cniska/dim-factory",
];

function queued(database: Database): void {
  runOrderCommand(database, add);
}

function started(database: Database, orderId = "order-1"): void {
  startOrder(database, orderId, resolveWorker(database, env), undefined, trunk.dir);
}

function building(database: Database): void {
  const operator = resolveWorker(database, env);
  started(database);
  attemptIn(database, "order-1", operator, operator);
}

function atBuild(database: Database): void {
  const operator = resolveWorker(database, env);
  started(database);
  approvePlan(database, "order-1", operator);
  attemptIn(database, "order-1", operator, operator, "run-2");
}

function approvedAt(database: Database, sha: string): void {
  const operator = resolveWorker(database, env);
  approveFinalBuildAt(database, "order-1", sha, operator, operator);
  approveReviewAt(database, "order-1", sha, operator);
}

function operatorEnv(database: Database): Env {
  const operator = mintWorker(database, { role: "operator", sessionId: newWorkerSession("test-operator") });
  return { ...machine.env, [WORKER_NAME_VAR]: operator.name };
}

describe("order command", () => {
  test("an added order waits on the board under its own name", () => {
    const database = db();

    expect(runOrderCommand(database, add)).toBe("queued order-1 on cniska/dim-factory");

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ queued: 1, running: 0, shipped: 0 });
    expect(snapshot.orders[0]?.title).toBe("Record a factory order as work is taken");
    expect(snapshot.orders[0]?.line).toBe("fix");
    expect(snapshot.orders[0]?.status).toBe("queued");
  });

  test("an unknown order line is refused", () => {
    const database = db();

    expect(() =>
      runOrderCommand(database, [...add.slice(0, 6), "--line", "unknown", ...add.slice(8)]),
    ).toThrow("unknown is not a line; one of feat, fix");
  });

  test("a delegation resolves its model through the harness it names", async () => {
    const database = db();
    runOrderCommand(database, add);

    await expect(
      runOrderCommandLive(database, ["plan", "order-1", "--harness", "claude"], null, trunk.dir, env),
    ).rejects.toThrow(
      expect.objectContaining({ kind: "no-map", message: expect.stringContaining('{ "claude": {') }),
    );
    expect(database.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 0 });
  });

  test("a build and a review resolve their models through the harness they name", async () => {
    const noClaudeMap = expect.objectContaining({
      kind: "no-map",
      message: expect.stringContaining('{ "claude": {'),
    });
    const database = db();
    queued(database);
    started(database);
    const operator = resolveWorker(database, env);
    approvePlan(database, "order-1", operator);

    await expect(
      runOrderCommandLive(database, ["build", "order-1", "--harness", "claude"], null, trunk.dir, env),
    ).rejects.toThrow('{ "claude": {');

    recordOrderCommit(database, "order-1", "abc123", operator, "feat: land it");
    attemptIn(database, "order-1", operator, operator, "run-2");
    approveFinalBuildAt(database, "order-1", "abc123", operator, operator);

    await expect(
      runOrderCommandLive(database, ["review", "order-1", "--harness", "claude"], null, trunk.dir, env),
    ).rejects.toThrow(noClaudeMap);
    expect(database.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 0 });
  });

  test("a delegation that names no harness runs under the one its operator is recorded in", async () => {
    const database = db();
    runOrderCommand(database, add);
    const operator = resolveWorker(database, env);
    const session = database
      .query<{ session_id: string }, [string]>("SELECT session_id FROM factory_worker WHERE name = ?")
      .get(operator)?.session_id;
    mintWorker(database, { role: "builder", sessionId: "another-session" });
    const recorded =
      "INSERT INTO hook_event (tool, session_id, event, ts, payload) VALUES (?, ?, ?, ?, '{}')";
    database.run(recorded, ["codex", "another-session", "session_start", "2025-12-31T00:00:00Z"]);
    database.run(recorded, ["codex", session ?? "", "post_tool_use", "2025-12-31T00:00:00Z"]);
    database.run(recorded, ["claude", session ?? "", "session_start", "2026-01-01T00:00:00Z"]);

    await expect(runOrderCommandLive(database, ["plan", "order-1"], null, trunk.dir, env)).rejects.toThrow(
      expect.objectContaining({ kind: "no-map", message: expect.stringContaining('{ "claude": {') }),
    );
    expect(database.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 0 });
  });

  test("a delegation that names no harness runs under its bound worker's harness before the operator's, and a released one's not at all", async () => {
    const database = db();
    runOrderCommand(database, add);
    const operator = resolveWorker(database, env);
    database.run(
      `INSERT INTO hook_event (tool, session_id, event, ts, payload)
       SELECT 'claude', session_id, 'session_start', '2026-01-01T00:00:00Z', '{}' FROM factory_worker WHERE name = ?`,
      [operator],
    );
    const planner = ensureOrderWorker(database, "order-1", "planner", operator, "codex");
    bootstrapWorker(database, { harness: "codex", id: planner.assignment.id, sessionId: "codex-planner" });

    await expect(runOrderCommandLive(database, ["plan", "order-1"], null, trunk.dir, env)).rejects.toThrow(
      expect.objectContaining({ kind: "no-map", message: expect.stringContaining('{ "codex": {') }),
    );

    releaseOrderWorker(database, "order-1", "planner");
    await expect(runOrderCommandLive(database, ["plan", "order-1"], null, trunk.dir, env)).rejects.toThrow(
      expect.objectContaining({ kind: "no-map", message: expect.stringContaining('{ "claude": {') }),
    );
  });

  test("a delegation that names no harness is refused when the record holds none for its operator", async () => {
    const database = db();
    runOrderCommand(database, add);
    const operator = resolveWorker(database, env);

    const refusal = `${operator} runs in no recorded harness session; delegate with --harness <codex|claude|grok>`;
    for (const station of ["plan", "build", "review"]) {
      await expect(runOrderCommandLive(database, [station, "order-1"], null, trunk.dir, env)).rejects.toThrow(
        refusal,
      );
    }
    expect(database.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 0 });
  });

  test("a delegation that names no harness is refused even where routing.json maps one", async () => {
    const database = db();
    runOrderCommand(database, add);
    const operator = resolveWorker(database, env);
    const mapped = collectingMachine();
    mkdirSync(join(mapped.dir, "home"), { recursive: true });
    writeFileSync(
      join(mapped.dir, "home", "routing.json"),
      '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }',
    );
    const as = { ...mapped.env, [WORKER_NAME_VAR]: operator };

    const refusal = `${operator} runs in no recorded harness session; delegate with --harness <codex|claude|grok>`;
    for (const station of ["plan", "build", "review"]) {
      await expect(runOrderCommandLive(database, [station, "order-1"], null, trunk.dir, as)).rejects.toThrow(
        refusal,
      );
    }
    expect(database.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 0 });
    rmSync(mapped.dir, { recursive: true, force: true });
  });

  test("a delegation to a harness with no adapter is refused", async () => {
    const database = db();
    runOrderCommand(database, add);

    for (const station of ["plan", "build", "review"]) {
      await expect(
        runOrderCommandLive(database, [station, "order-1", "--harness", "gemini"], null, trunk.dir, env),
      ).rejects.toThrow("gemini: unsupported harness; supported harnesses: codex, claude");
    }
  });

  test("a started order moves into the running column at the plan station", () => {
    const database = db();
    queued(database);

    started(database);

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ queued: 0, running: 1, shipped: 0 });
    expect(snapshot.orders[0]?.status).toBe("running");
    expect(snapshot.orders[0]?.station).toBe("plan");
    expect(snapshot.orders[0]?.next).toBe("run");
  });

  test("an order keeps the description it was queued with", () => {
    const database = db();

    queued(database);
    started(database);

    expect(database.query("SELECT description FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      description: "The record holds what an order is called and never what it says.",
    });
  });

  test("an order queued with no description records without one", () => {
    const database = db();
    const at = add.indexOf("--description");

    runOrderCommand(database, [...add.slice(0, at), ...add.slice(at + 2)]);

    expect(database.query("SELECT description FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      description: null,
    });
  });

  test("an approval takes the artifact the record waits on at each station", () => {
    const database = db();
    queued(database);
    started(database);
    const operator = resolveWorker(database, env);

    expect(() => runOrderCommand(database, ["approve", "order-1"])).toThrow(
      expect.objectContaining({
        code: "not_next",
        message:
          "order order-1 waits on run at plan, so it cannot approve; its next act is `dim order plan order-1`",
      }),
    );
    recordOrderPlan(database, "order-1", "## Outcome\n\nBuild it.", operator, [
      { title: "Build it", outcome: "It is verified." },
    ]);
    expect(runOrderCommand(database, ["return", "order-1", "--reason", "name the check"])).toBe(
      "order-1 plan artifact returned to plan",
    );
    recordOrderPlan(database, "order-1", "## Outcome\n\nBuild it, checked.", operator, [
      { title: "Build it", outcome: "It is verified." },
    ]);
    expect(runOrderCommand(database, ["approve", "order-1"])).toBe(`order-1 plan approved by ${operator}`);

    attemptIn(database, "order-1", operator, operator);
    landed(database, "order-1");
    recordOrderBuild(database, "order-1", "## Result\n\nBuilt.", trunk.sha, operator);
    completeOrderSlice(database, "order-1", nextOrderSlice(database, "order-1")?.id as number, operator);
    expect(() => runOrderCommand(database, ["approve", "order-1"])).toThrow(
      "build approval reason must not be empty",
    );
    expect(runOrderCommand(database, ["approve", "order-1", "--reason", "the check passes"])).toBe(
      `order-1 build approved by ${operator}`,
    );

    const round = reviewIn(database, "order-1", undefined, trunk.sha);
    recordOrderReviewArtifact(database, "order-1", "## Outcome\n\nClean.", round.reviewer);
    closeOrderReview(database, round.review, "closed");
    expect(runOrderCommand(database, ["approve", "order-1"])).toBe(
      `order-1 review approved by ${operator}; order-1 is already on the default branch and shipped`,
    );
    expect(
      database
        .query("SELECT kind, worker FROM factory_order_event WHERE order_id = ? ORDER BY id DESC LIMIT 1")
        .all("order-1"),
    ).toEqual([{ kind: "artifact_approved", worker: operator }]);
    expect(database.query("SELECT outcome FROM factory_order_ship_run").all()).toEqual([
      { outcome: "landed" },
    ]);
    expect(() => runOrderCommand(database, ["approve", "order-1"])).toThrow(
      expect.objectContaining({
        code: "order_terminal",
        message: "order order-1 is shipped, so it cannot approve; nothing more runs on a shipped order",
      }),
    );
  });

  test("an operator can return an approved plan while the order waits on build", () => {
    const database = db();
    queued(database);
    started(database);
    approvePlan(database, "order-1", resolveWorker(database, env));

    expect(
      runOrderCommand(database, ["return", "order-1", "--to", "plan", "--reason", "revise the slices"]),
    ).toBe("order-1 plan artifact returned to plan");
    expect(orderState(database, "order-1")).toEqual({ station: "plan", next: "run" });
  });

  test("an operator can return review to build for a code correction", () => {
    const database = db();
    queued(database);
    started(database);
    const operator = resolveWorker(database, env);
    approvePlan(database, "order-1", operator);
    attemptIn(database, "order-1", operator, operator);
    landed(database, "order-1");
    recordOrderBuild(database, "order-1", "Built the approved plan.", trunk.sha, operator);
    const slice = nextOrderSlice(database, "order-1");
    if (!slice) throw new Error("the order has no slice");
    completeOrderSlice(database, "order-1", slice.id, operator);
    runOrderCommand(database, ["approve", "order-1", "--reason", "the check passed"]);
    const round = reviewIn(database, "order-1", undefined, trunk.sha);
    recordOrderReviewArtifact(database, "order-1", "The review found no defect.", round.reviewer);
    closeOrderReview(database, round.review, "closed");

    expect(
      runOrderCommand(database, ["return", "order-1", "--to", "build", "--reason", "fix the code"]),
    ).toBe("order-1 review and build artifacts returned to build");
    expect(orderState(database, "order-1")).toEqual({ station: "build", next: "run" });
    expect(
      database
        .query<{ kind: string; station: string }, []>(
          "SELECT kind, station FROM factory_order_event WHERE kind = 'artifact_returned' ORDER BY id",
        )
        .all(),
    ).toEqual([
      { kind: "artifact_returned", station: "review" },
      { kind: "artifact_returned", station: "build" },
    ]);
  });

  test("a ship lands the order's own commits on the trunk", () => {
    const database = db();
    queued(database);
    atBuild(database);
    const wt = join(trunk.dir, ".claude", "worktrees", "order-1");
    writeFileSync(join(wt, "ship-a.txt"), "a");
    Bun.spawnSync(["git", "-C", wt, "add", "."]);
    Bun.spawnSync(["git", "-C", wt, "commit", "-q", "-m", "feat: ship-a"]);
    const sha = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], { stdout: "pipe" })
      .stdout.toString()
      .trim();
    recordOrderCommit(database, "order-1", sha, resolveWorker(database, env), "feat: ship-a");
    approvedAt(database, sha);
    const operator = resolveWorker(database, env);
    const stray = join(trunk.dir, "stray.txt");
    writeFileSync(stray, "uncommitted");

    expect(() => runOrderCommand(database, ["ship", "order-1"], null, wt)).toThrow(
      expect.objectContaining({ code: "ship_dirty_trunk" }),
    );
    expect(database.query("SELECT outcome, code FROM factory_order_ship_run").all()).toEqual([
      { outcome: "refused", code: "ship_dirty_trunk" },
    ]);
    expect(orderStatus(database, "order-1")).toBe("running");
    rmSync(stray);

    expect(runOrderCommand(database, ["ship", "order-1"], null, wt)).toBe(
      "order-1 is fast-forwarded onto the default branch and shipped",
    );

    expect(Bun.spawnSync(["git", "-C", trunk.dir, "merge-base", "--is-ancestor", sha, "HEAD"]).success).toBe(
      true,
    );
    expect(
      database
        .query("SELECT kind, worker FROM factory_order_event WHERE order_id = ? ORDER BY id DESC LIMIT 3")
        .all("order-1"),
    ).toEqual([
      { kind: "ship_retried", worker: operator },
      { kind: "ship_retried", worker: operator },
      { kind: "artifact_approved", worker: operator },
    ]);
    expect(database.query("SELECT outcome, code FROM factory_order_ship_run ORDER BY id").all()).toEqual([
      { outcome: "refused", code: "ship_dirty_trunk" },
      { outcome: "landed", code: null },
    ]);
    expect(orderStatus(database, "order-1")).toBe("shipped");
  });

  test("a ship whose rebase git refuses records the rebase's code on its ship run", () => {
    const database = db();
    queued(database);
    atBuild(database);
    const wt = join(trunk.dir, ".claude", "worktrees", "order-1");
    writeFileSync(join(wt, "ship-vetoed.txt"), "v");
    Bun.spawnSync(["git", "-C", wt, "add", "."]);
    Bun.spawnSync(["git", "-C", wt, "commit", "-q", "-m", "feat: ship-vetoed"]);
    const sha = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], { stdout: "pipe" })
      .stdout.toString()
      .trim();
    recordOrderCommit(database, "order-1", sha, resolveWorker(database, env), "feat: ship-vetoed");
    approvedAt(database, sha);
    writeFileSync(join(trunk.dir, "trunk-moved.txt"), "moved");
    Bun.spawnSync(["git", "-C", trunk.dir, "add", "."]);
    Bun.spawnSync(["git", "-C", trunk.dir, "commit", "-q", "-m", "feat: move the trunk"]);
    const hooks = Bun.spawnSync(
      ["git", "-C", wt, "rev-parse", "--path-format=absolute", "--git-path", "hooks"],
      {
        stdout: "pipe",
      },
    )
      .stdout.toString()
      .trim();
    mkdirSync(hooks, { recursive: true });
    const veto = join(hooks, "pre-rebase");
    writeFileSync(veto, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    try {
      expect(() => runOrderCommand(database, ["ship", "order-1"], null, wt)).toThrow(
        expect.objectContaining({ code: "rebase_failed" }),
      );
      expect(database.query("SELECT outcome, code FROM factory_order_ship_run").all()).toEqual([
        { outcome: "refused", code: "rebase_failed" },
      ]);
    } finally {
      rmSync(veto);
      Bun.spawnSync(["git", "-C", trunk.dir, "reset", "-q", "--hard", "HEAD~1"]);
    }
  });

  test("a ship run from the trunk checkout still lands the order's branch", () => {
    const database = db();
    queued(database);
    atBuild(database);
    const wt = join(trunk.dir, ".claude", "worktrees", "order-1");
    writeFileSync(join(wt, "ship-b.txt"), "b");
    Bun.spawnSync(["git", "-C", wt, "add", "."]);
    Bun.spawnSync(["git", "-C", wt, "commit", "-q", "-m", "feat: ship-b"]);
    const sha = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], { stdout: "pipe" })
      .stdout.toString()
      .trim();
    recordOrderCommit(database, "order-1", sha, resolveWorker(database, env), "feat: ship-b");
    approvedAt(database, sha);

    expect(runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toBe(
      "order-1 is fast-forwarded onto the default branch and shipped",
    );

    expect(Bun.spawnSync(["git", "-C", trunk.dir, "merge-base", "--is-ancestor", sha, "HEAD"]).success).toBe(
      true,
    );
  });

  test("a ship of a commit already on the trunk reports it as already landed and moves the card to shipped", () => {
    const database = db();
    queued(database);
    atBuild(database);
    landed(database, "order-1");
    approvedAt(database, trunk.sha);

    expect(runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toBe(
      "order-1 is already on the default branch and shipped",
    );
    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ queued: 0, running: 0, shipped: 1 });
    expect(snapshot.orders[0]?.status).toBe("shipped");
  });

  test("a ship names the branch it kept and why", () => {
    const database = db();
    queued(database);
    atBuild(database);
    const wt = join(trunk.dir, ".claude", "worktrees", "order-1");
    writeFileSync(join(wt, "unlanded.txt"), "unlanded");
    Bun.spawnSync(["git", "-C", wt, "add", "."]);
    Bun.spawnSync(["git", "-C", wt, "commit", "-q", "-m", "feat: unlanded"]);
    const tip = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], { stdout: "pipe" })
      .stdout.toString()
      .trim();
    landed(database, "order-1");
    approvedAt(database, trunk.sha);

    expect(runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toBe(
      `order-1 is already on the default branch and shipped; branch order-1 kept: its tip ${tip} has not landed on the default branch`,
    );
    Bun.spawnSync(["git", "-C", trunk.dir, "branch", "-D", "order-1"]);
  });

  test("a ship and the order query name the worktree it kept and why", () => {
    const repo = integratedRepo();
    try {
      mkdirSync(join(repo.dir, "scripts"));
      writeFileSync(join(repo.dir, "scripts", "worktree-teardown.sh"), "#!/bin/sh\nexit 3\n", {
        mode: 0o755,
      });
      Bun.spawnSync(["git", "-C", repo.dir, "add", "scripts/worktree-teardown.sh"]);
      Bun.spawnSync(["git", "-C", repo.dir, "commit", "-q", "-m", "test: fail teardown"]);
      const database = db();
      const operator = resolveWorker(database, env);
      queued(database);
      startOrder(database, "order-1", operator, undefined, repo.dir);
      approvePlan(database, "order-1", operator);
      attemptIn(database, "order-1", operator, operator, "run-2");
      const wt = join(repo.dir, ".claude", "worktrees", "order-1");
      writeFileSync(join(wt, "kept.txt"), "kept");
      Bun.spawnSync(["git", "-C", wt, "add", "."]);
      Bun.spawnSync(["git", "-C", wt, "commit", "-q", "-m", "feat: keep the worktree"]);
      const sha = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], { stdout: "pipe" })
        .stdout.toString()
        .trim();
      recordOrderCommit(database, "order-1", sha, operator, "feat: keep the worktree");
      approveFinalBuildAt(database, "order-1", sha, operator, operator);
      approveReviewAt(database, "order-1", sha, operator);

      expect(runOrderCommand(database, ["ship", "order-1"], null, repo.dir)).toBe(
        "order-1 is fast-forwarded onto the default branch and shipped; " +
          "worktree kept: its teardown hook exited 3; branch order-1 kept: its worktree still holds it",
      );
      expect(orderStatus(database, "order-1")).toBe("shipped");
      const report = findQuery("order")?.run(database, { arg: "order-1", home: "/h", maxRows: 40 });
      const shipRun = report?.rows.find((row) => row[0] === "ship_run");
      expect(shipRun?.[report?.columns.indexOf("evidence") ?? -1]).toBe(
        "worktree kept: its teardown hook exited 3 | branch kept: its worktree still holds it",
      );
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  test("a ship is refused before the order recorded any commit", () => {
    const database = db();
    queued(database);
    atBuild(database);
    const operator = resolveWorker(database, env);
    completeOrderSlice(database, "order-1", nextOrderSlice(database, "order-1")?.id as number, operator);

    expect(() => runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toThrow(
      expect.objectContaining({
        code: "not_next",
        message:
          "order order-1 waits on run at build, so it cannot ship; its next act is `dim order build order-1`",
      }),
    );
    expect(database.query("SELECT kind FROM factory_order_event WHERE kind = 'ship_retried'").all()).toEqual(
      [],
    );
  });

  test("a ship is refused before the plan is approved", () => {
    const database = db();
    queued(database);
    started(database);
    landed(database, "order-1");

    expect(() => runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toThrow(
      expect.objectContaining({
        code: "not_next",
        message:
          "order order-1 waits on run at plan, so it cannot ship; its next act is `dim order plan order-1`",
      }),
    );
  });

  test("a ship is refused before the review is approved", () => {
    const database = db();
    queued(database);
    atBuild(database);
    landed(database, "order-1");
    const operator = resolveWorker(database, env);
    approveFinalBuildAt(database, "order-1", trunk.sha, operator, operator);

    expect(() => runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toThrow(
      expect.objectContaining({
        code: "not_next",
        message:
          "order order-1 waits on run at review, so it cannot ship; its next act is `dim order review order-1`",
      }),
    );
  });

  test("a station worker cannot ship an order", () => {
    const database = db();
    queued(database);
    atBuild(database);
    landed(database, "order-1");
    approvedAt(database, trunk.sha);
    const builder = mintWorker(database, {
      role: "builder",
      parentWorker: env[WORKER_NAME_VAR] as string,
      sessionId: newWorkerSession("ship-builder"),
      pid: process.ppid,
    });
    database.run("UPDATE factory_worker SET pid = NULL, process_started_at = NULL WHERE role = 'operator'");

    expect(() =>
      runOrderCommand(database, ["ship", "order-1"], null, trunk.dir, {
        ...machine.env,
        [WORKER_NAME_VAR]: builder.name,
      }),
    ).toThrow(expect.objectContaining({ code: "worker_not_operator" }));
  });

  test("a ship is refused before the order is started", () => {
    const database = db();
    queued(database);

    expect(() => runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toThrow(
      expect.objectContaining({ code: "not_next" }),
    );
  });

  test("a failed order stays running at the station its record puts it", () => {
    const database = db();
    queued(database);
    started(database);

    appendOrderEvent(database, "order-1", {
      kind: "failed",
      station: "build",
      reason: "the check never passed",
    });

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ queued: 0, running: 1, shipped: 0 });
    expect(snapshot.orders[0]?.status).toBe("running");
    expect([snapshot.orders[0]?.station, snapshot.orders[0]?.next]).toEqual(["plan", "run"]);
  });

  test("ready lists the queued orders most urgent first", () => {
    const database = db();
    runOrderCommand(database, add);
    runOrderCommand(database, ["add", "order-2", "--title", "Later", "--project", "cniska/dim-factory"]);
    runOrderCommand(database, ["priority", "order-2", "urgent"]);
    runOrderCommand(database, ["add", "order-3", "--title", "Taken", "--project", "cniska/dim-factory"]);
    runOrderCommand(database, ["priority", "order-3", "urgent"]);
    started(database, "order-3");

    const read = runCommand(database, ["ready", "--project", "cniska/dim-factory"], null, trunk.dir, env) as {
      id: string;
    }[];

    expect(read.map((one) => one.id)).toEqual(["order-2", "order-1"]);
  });

  test("commits, files, checks, documents and artifacts are not written from the command line", () => {
    const database = db();
    queued(database);
    building(database);

    for (const command of ["commit", "file", "check", "document", "build-artifact", "review-artifact"]) {
      expect(() => runOrderCommand(database, [command, "order-1"])).toThrow(
        `${command} is not an order subcommand`,
      );
    }
  });

  test("raises and answers no finding from the command line", () => {
    const database = db();
    queued(database);
    started(database);

    expect(() =>
      runOrderCommand(database, ["finding", "order-1", "--dimension", "tests", "--summary", "s"]),
    ).toThrow("finding is not an order subcommand");
    expect(() => runOrderCommand(database, ["answer", "1", "--answer", "fixed"])).toThrow(
      "answer is not an order subcommand",
    );
  });

  test("an order queued without a title is refused before any row is written", () => {
    const database = db();

    expect(() => runOrderCommand(database, ["add", "order-1", "--project", "cniska/dim-factory"])).toThrow(
      UsageError,
    );
    expect(assembleWallSnapshot(database).orders).toEqual([]);
  });

  test("an order id cannot leave the task worktree directory", () => {
    const database = db();

    expect(() =>
      runOrderCommand(database, [
        "add",
        "../outside",
        "--title",
        "Unsafe",
        "--project",
        "cniska/dim-factory",
      ]),
    ).toThrow(/invalid branch name/);
    expect(assembleWallSnapshot(database).orders).toEqual([]);
    expect(() =>
      runOrderCommand(database, ["add", "@{-1}", "--title", "Unsafe", "--project", "cniska/dim-factory"]),
    ).toThrow(/invalid branch name/);
  });

  test("a plan is refused on a machine whose session hooks were never installed", async () => {
    const database = db();
    queued(database);
    const bare = mkdtempSync(join(tmpdir(), "dim-bare-"));

    await expect(
      runOrderCommandLive(database, ["plan", "order-1", "--harness", "claude"], null, trunk.dir, {
        ...env,
        ...scratchEnv(bare),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "hooks_missing" }));
    expect(assembleWallSnapshot(database).totals).toEqual({ queued: 1, running: 0, shipped: 0 });
    rmSync(bare, { recursive: true, force: true });
  });

  for (const station of ["build", "review"] as const) {
    test(`a ${station} is refused on a machine whose session hooks were never installed`, async () => {
      const database = db();
      queued(database);
      started(database);
      const operator = resolveWorker(database, env);
      approvePlan(database, "order-1", operator);
      if (station === "review") {
        attemptIn(database, "order-1", operator, operator);
        landed(database, "order-1");
        approveFinalBuildAt(database, "order-1", trunk.sha, operator, operator);
      }
      expect(orderState(database, "order-1")).toEqual({ station, next: "run" });
      const attempts = database.query("SELECT count(*) AS n FROM factory_order_attempt").get();
      const bare = mkdtempSync(join(tmpdir(), "dim-bare-"));

      await expect(
        runOrderCommandLive(database, [station, "order-1", "--harness", "claude"], null, trunk.dir, {
          ...env,
          ...scratchEnv(bare),
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "hooks_missing" }));
      expect(database.query("SELECT count(*) AS n FROM factory_order_attempt").get()).toEqual(attempts);
      rmSync(bare, { recursive: true, force: true });
    });
  }

  test("a plan is refused where a session hook is written against an older contract", async () => {
    const database = db();
    queued(database);
    const older = collectingMachine();
    for (const tool of TOOLS) {
      const config = hookConfigPath(tool, older.env);
      writeFileSync(config, readFileSync(config, "utf8").replaceAll(/dim-hook:\d+/g, "dim-hook:1"));
    }

    await expect(
      runOrderCommandLive(database, ["plan", "order-1", "--harness", "claude"], null, trunk.dir, {
        ...env,
        ...older.env,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "hooks_stale" }));
    expect(assembleWallSnapshot(database).totals).toEqual({ queued: 1, running: 0, shipped: 0 });
    rmSync(older.dir, { recursive: true, force: true });
  });

  test("every write is refused where nothing says which worker is making it", () => {
    const database = db();
    queued(database);
    const namedOnly = { ...env };
    database.run("UPDATE factory_worker SET pid = NULL, process_started_at = NULL WHERE role = 'operator'");

    for (const args of [
      add,
      ["priority", "order-1", "urgent"],
      ["approve", "order-1"],
      ["drop", "order-1", "--reason", "not needed"],
    ]) {
      expect(() => runCommand(database, args, null, undefined, {})).toThrow(
        expect.objectContaining({ code: "worker_missing" }),
      );
      expect(() => runCommand(database, args, null, undefined, namedOnly)).toThrow(
        expect.objectContaining({ code: "worker_missing" }),
      );
    }
    expect(database.query("SELECT count(*) AS n FROM factory_order_event").get()).toEqual({ n: 1 });
  });

  test("an unknown subcommand, an unknown flag and a repeated flag are refused", () => {
    const database = db();

    expect(() => runOrderCommand(database, ["park", "order-1"])).toThrow(UsageError);
    expect(() => runOrderCommand(database, ["stop", "order-1", "completed"])).toThrow(UsageError);
    expect(() => runOrderCommand(database, ["toString", "order-1"])).toThrow(UsageError);
    expect(() => runOrderCommand(database, [...add, "--colour", "red"])).toThrow(UsageError);
    expect(() => runOrderCommand(database, [...add, "--title", "second"])).toThrow(UsageError);
  });

  test("an amend corrects a queued order's own words", () => {
    const database = db();
    queued(database);

    expect(runOrderCommand(database, ["amend", "order-1", "--title", "A corrected title"])).toBe(
      "order-1 amended",
    );

    expect(database.query("SELECT title, description FROM factory_order WHERE id = 'order-1'").get()).toEqual(
      {
        title: "A corrected title",
        description: "The record holds what an order is called and never what it says.",
      },
    );
  });

  test("an amend with neither flag is a refusal, not a no-op", () => {
    const database = db();
    queued(database);

    expect(() => runOrderCommand(database, ["amend", "order-1"])).toThrow(UsageError);
  });

  test("an amend is refused once the order is started", () => {
    const database = db();
    queued(database);
    started(database);

    expect(() => runOrderCommand(database, ["amend", "order-1", "--title", "too late"])).toThrow(
      expect.objectContaining({ code: "order_not_queued" }),
    );
  });

  test("a drop takes a queued order off the wall entirely, carrying the reason", () => {
    const database = db();
    queued(database);

    expect(
      runOrderCommand(
        database,
        ["drop", "order-1", "--reason", "superseded elsewhere"],
        null,
        trunk.dir,
        operatorEnv(database),
      ),
    ).toBe("order-1 is dropped: superseded elsewhere");

    expect(orderStatus(database, "order-1")).toBe("dropped");
    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ queued: 0, running: 0, shipped: 0 });
    expect(snapshot.orders).toEqual([]);
  });

  test("a drop needs a reason", () => {
    const database = db();
    queued(database);

    expect(() =>
      runOrderCommand(database, ["drop", "order-1"], null, trunk.dir, operatorEnv(database)),
    ).toThrow(UsageError);
  });

  test("a station worker cannot drop an order", () => {
    const database = db();
    queued(database);
    const builder = mintWorker(database, {
      role: "builder",
      parentWorker: env[WORKER_NAME_VAR] as string,
      sessionId: newWorkerSession("drop-builder"),
      pid: process.ppid,
    });
    database.run("UPDATE factory_worker SET pid = NULL, process_started_at = NULL WHERE role = 'operator'");

    expect(() =>
      runOrderCommand(database, ["drop", "order-1", "--reason", "disposable"], null, trunk.dir, {
        ...machine.env,
        [WORKER_NAME_VAR]: builder.name,
      }),
    ).toThrow(expect.objectContaining({ code: "worker_not_operator" }));
    expect(orderStatus(database, "order-1")).toBe("queued");
  });

  test("a drop is refused while an attempt is running on the order", () => {
    const database = db();
    queued(database);
    building(database);

    expect(() =>
      runOrderCommand(
        database,
        ["drop", "order-1", "--reason", "too late to drop"],
        null,
        trunk.dir,
        operatorEnv(database),
      ),
    ).toThrow(expect.objectContaining({ code: "order_held_by_run" }));
  });

  test("a dropped order cannot be started, amended or dropped again", () => {
    const database = db();
    queued(database);
    runOrderCommand(
      database,
      ["drop", "order-1", "--reason", "not worth building"],
      null,
      trunk.dir,
      operatorEnv(database),
    );

    expect(() => started(database)).toThrow(expect.objectContaining({ code: "order_not_queued" }));
    expect(() => runOrderCommand(database, ["amend", "order-1", "--title", "too late"])).toThrow(
      expect.objectContaining({ code: "order_not_queued" }),
    );
    expect(() =>
      runOrderCommand(
        database,
        ["drop", "order-1", "--reason", "again"],
        null,
        trunk.dir,
        operatorEnv(database),
      ),
    ).toThrow("order-1 is already dropped");
  });
});

describe("a build command", () => {
  test("runs each remaining slice and stops when the order is no longer waiting on build", async () => {
    let step = 0;
    const progress = ["slice-1", "slice-2", "done"];

    const outcome = await runRemainingBuilds(
      "order-1",
      () => ({ waiting: step < 2, progress: progress[step] ?? "done" }),
      async () => {
        step += 1;
        return step;
      },
    );

    expect(outcome).toBe(2);
  });

  test("stops when a turn leaves the order waiting on build without moving it", async () => {
    await expect(
      runRemainingBuilds(
        "order-1",
        () => ({ waiting: true, progress: "slice-1" }),
        async () => "turn",
      ),
    ).rejects.toThrow("order order-1 is still run at build and the turn did not advance");
  });

  test("does not start another slice after a turn fails", async () => {
    let runs = 0;

    await expect(
      runRemainingBuilds(
        "order-1",
        () => ({ waiting: true, progress: "slice-1" }),
        async () => {
          runs += 1;
          throw new Error("ok.txt is missing");
        },
      ),
    ).rejects.toThrow("ok.txt is missing");
    expect(runs).toBe(1);
  });
});
