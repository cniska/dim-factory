import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./cli-contract";
import { SCHEMA_SQL } from "./db-schema";
import { pullStop } from "./factory-stop";
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
import { completeOrderSlice, nextOrderSlice, recordOrderBuild, recordOrderPlan } from "./order-artifacts";
import { runOrderCommand as runCommand, runOrderCommandLive } from "./order-command";
import { recordOrderCheck, recordOrderCommit } from "./order-evidence";
import { appendOrderEvent } from "./order-ledger";
import { startOrder } from "./order-lifecycle";
import { closeOrderReview, recordOrderReviewArtifact } from "./order-review";
import { orderStatus } from "./order-status";
import type { Env } from "./paths";
import { approveFinalBuildAt, approvePlan, approveReviewAt } from "./station-approvals.test-support";
import { assembleWallSnapshot } from "./wall-server";
import { mintWorker, newWorkerSession, resolveWorker, WORKER_NAME_VAR, WORKER_TOKEN_VAR } from "./worker";

const opened: Database[] = [];

let env: Env = {};

const machine = collectingMachine();

function db(): Database {
  const database = new Database(":memory:");
  database.run(SCHEMA_SQL);
  const operator = mintWorker(database, { role: "operator", sessionId: newWorkerSession("test-operator") });
  env = { ...machine.env, [WORKER_NAME_VAR]: operator.name, [WORKER_TOKEN_VAR]: operator.token };
  opened.push(database);
  return database;
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
  recordOrderCheck(database, orderId, ranCheck({ command: "bun run verify", exitCode: 0 }), operator);
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
  return { ...machine.env, [WORKER_NAME_VAR]: operator.name, [WORKER_TOKEN_VAR]: operator.token };
}

describe("order command", () => {
  test("an added order waits on the board under its own name", () => {
    const database = db();

    expect(runOrderCommand(database, add)).toBe("queued order-1 on cniska/dim-factory");

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 1, active: 0, done: 0 });
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
    expect(database.query("SELECT role, harness FROM factory_order_worker").all()).toEqual([
      { role: "planner", harness: "claude" },
    ]);
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
    expect(database.query("SELECT role, harness FROM factory_order_worker ORDER BY role").all()).toEqual([
      { role: "builder", harness: "claude" },
      { role: "reviewer", harness: "claude" },
    ]);
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
    expect(database.query("SELECT role, harness FROM factory_order_worker").all()).toEqual([
      { role: "planner", harness: "claude" },
    ]);
  });

  test("a delegation that names no harness is refused when the record holds none for its operator", async () => {
    const database = db();
    runOrderCommand(database, add);
    const operator = resolveWorker(database, env);

    const refusal = `${operator} runs in no recorded harness session; delegate with --harness <codex|claude>`;
    for (const station of ["plan", "build", "review"]) {
      await expect(runOrderCommandLive(database, [station, "order-1"], null, trunk.dir, env)).rejects.toThrow(
        refusal,
      );
    }
    expect(database.query("SELECT count(*) AS n FROM factory_order_worker").get()).toEqual({ n: 0 });
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

  test("a started order moves into the active column at the plan station", () => {
    const database = db();
    queued(database);

    started(database);

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 1, done: 0 });
    expect(snapshot.orders[0]?.status).toBe("active");
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
        message: "order order-1 waits on run at plan, so it cannot approve",
      }),
    );
    recordOrderPlan(database, "order-1", "## Outcome\n\nBuild it.", operator, [
      { title: "Build it", outcome: "It is verified." },
    ]);
    expect(runOrderCommand(database, ["return", "order-1", "--reason", "name the check"])).toBe(
      "order-1 plan artifact returned to its worker",
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

    const round = reviewIn(database, "order-1", operator, undefined, trunk.sha);
    recordOrderReviewArtifact(database, "order-1", "## Outcome\n\nClean.", round.reviewer);
    closeOrderReview(database, round.review, "closed", round.reviewer);
    expect(runOrderCommand(database, ["approve", "order-1"])).toBe(
      `order-1 review approved by ${operator}; order-1 is already on the trunk and done`,
    );
    expect(() => runOrderCommand(database, ["approve", "order-1"])).toThrow(
      expect.objectContaining({
        code: "not_next",
        message: "order order-1 is done, so it cannot approve",
      }),
    );
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

    expect(runOrderCommand(database, ["ship", "order-1"], null, wt)).toBe(
      "order-1 is fast-forwarded onto the trunk and done",
    );

    expect(Bun.spawnSync(["git", "-C", trunk.dir, "merge-base", "--is-ancestor", sha, "HEAD"]).success).toBe(
      true,
    );
    expect(
      database
        .query("SELECT kind FROM factory_order_event WHERE order_id = ? ORDER BY id DESC")
        .get("order-1"),
    ).toEqual({ kind: "shipped" });
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
      "order-1 is fast-forwarded onto the trunk and done",
    );

    expect(Bun.spawnSync(["git", "-C", trunk.dir, "merge-base", "--is-ancestor", sha, "HEAD"]).success).toBe(
      true,
    );
  });

  test("a ship of a commit already on the trunk reports it as already landed and moves the card to done", () => {
    const database = db();
    queued(database);
    atBuild(database);
    landed(database, "order-1");
    approvedAt(database, trunk.sha);

    expect(runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toBe(
      "order-1 is already on the trunk and done",
    );
    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 0, done: 1 });
    expect(snapshot.orders[0]?.status).toBe("done");
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
        message: "order order-1 waits on run at build, so it cannot ship",
      }),
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
        message: "order order-1 waits on run at plan, so it cannot ship",
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
        message: "order order-1 waits on run at review, so it cannot ship",
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
    });

    expect(() =>
      runOrderCommand(database, ["ship", "order-1"], null, trunk.dir, {
        ...machine.env,
        [WORKER_NAME_VAR]: builder.name,
        [WORKER_TOKEN_VAR]: builder.token,
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

  test("a failed order stays active at the station its record puts it", () => {
    const database = db();
    queued(database);
    started(database);

    appendOrderEvent(database, "order-1", { kind: "failed", reason: "the check never passed" });

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 1, done: 0 });
    expect(snapshot.orders[0]?.status).toBe("active");
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

  test("a plan onto a stopped floor is refused with the reason the floor was stopped for", async () => {
    const database = db();
    queued(database);
    pullStop(database, { reason: "the commit gate records nothing" });

    await expect(
      runOrderCommandLive(database, ["plan", "order-1", "--harness", "claude"], null, trunk.dir, env),
    ).rejects.toThrow(/the commit gate records nothing/);
    expect(assembleWallSnapshot(database).totals).toEqual({ todo: 1, active: 0, done: 0 });
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
    expect(assembleWallSnapshot(database).totals).toEqual({ todo: 1, active: 0, done: 0 });
    rmSync(bare, { recursive: true, force: true });
  });

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
    expect(assembleWallSnapshot(database).totals).toEqual({ todo: 1, active: 0, done: 0 });
    rmSync(older.dir, { recursive: true, force: true });
  });

  test("every write is refused where nothing says which worker is making it", () => {
    const database = db();
    queued(database);
    const unissued = { ...env, DIM_WORKER_TOKEN: "not the one it was handed" };

    for (const args of [
      add,
      ["priority", "order-1", "urgent"],
      ["approve", "order-1"],
      ["drop", "order-1", "--reason", "not needed"],
    ]) {
      expect(() => runCommand(database, args, null, undefined, {})).toThrow(
        expect.objectContaining({ code: "worker_missing" }),
      );
      expect(() => runCommand(database, args, null, undefined, unissued)).toThrow(
        expect.objectContaining({ code: "worker_unissued" }),
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
    expect(snapshot.totals).toEqual({ todo: 0, active: 0, done: 0 });
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
    });

    expect(() =>
      runOrderCommand(database, ["drop", "order-1", "--reason", "disposable"], null, trunk.dir, {
        ...machine.env,
        [WORKER_NAME_VAR]: builder.name,
        [WORKER_TOKEN_VAR]: builder.token,
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
