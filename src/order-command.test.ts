import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOrderReview } from "./factory-order";
import { pullStop } from "./factory-stop";
import { assembleWallSnapshot } from "./factory-wall";
import { mintWorker, newWorkerSession, WORKER_NAME_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
import { collectingMachine, integratedRepo, scratchEnv, workerEnv } from "./fixtures.test-support";
import { hookConfigPath } from "./hooks";
import { OrderCommandError, runOrderCommand as runCommand } from "./order-command";
import type { Env } from "./paths";
import { SCHEMA_SQL } from "./schema";
import { TOOLS } from "./tools";

// Held so they close: an open handle is finalized by the runtime at exit instead, which is
// where a suite that reported no failures panics anyway.
const opened: Database[] = [];

// The environment the factory starts a worker in, which is where the command reads who
// it is. Set where the database is made, because the worker's row lives in that database.
let env: Env = {};

// A claim reads this machine's session hooks before it lets a run start, so every command
// below runs on one whose hooks are installed at the current contract.
const machine = collectingMachine();

function db(): Database {
  const database = new Database(":memory:");
  database.run(SCHEMA_SQL);
  env = { ...machine.env, ...workerEnv(database) };
  opened.push(database);
  return database;
}

// A claim now makes the worktree it names, so every call needs somewhere safe
// to make one — `trunk.dir` rather than this machine's own checkout.
function runOrderCommand(
  database: Database,
  args: string[],
  project: string | null = null,
  cwd: string = trunk.dir,
  as: Env = env,
): string {
  return runCommand(database, args, project, cwd, as);
}

/**
 * Opens a round and returns the environment its reviewer was started in. Minted here rather
 * than through `dim worker mint`, which refuses a read-only hand — a reviewer exists only
 * because the station that spawns it made one, and that is the whole of its worth.
 */
function reviewerEnv(database: Database, orderId: string): Env {
  const minted = mintWorker(database, { role: "reviewer", sessionId: newWorkerSession("test-reviewer") });
  openOrderReview(
    database,
    orderId,
    { reviewer: minted.name, baseSha: "base000", headSha: "head000" },
    env[WORKER_NAME_VAR] as string,
  );
  return { ...machine.env, [WORKER_NAME_VAR]: minted.name, [WORKER_TOKEN_VAR]: minted.token };
}

const trunk = integratedRepo();
afterAll(() => {
  for (const database of opened) database.close();
  rmSync(trunk.dir, { recursive: true, force: true });
  rmSync(machine.dir, { recursive: true, force: true });
});

/** What the gate wants before an order may complete: a commit on the trunk, then a check that passed. */
function landed(database: Database, orderId: string): void {
  runOrderCommand(database, ["commit", orderId, "--sha", trunk.sha, "--subject", "feat: land it"]);
  runOrderCommand(database, ["check", orderId, "--command", "bun run verify", "--exit", "0"]);
}

const add = [
  "add",
  "order-1",
  "--title",
  "Record a factory order as work is taken",
  "--description",
  "The record holds what an order is called and never what it says.",
  "--project",
  "cniska/dim-factory",
];

const claim = ["claim", "order-1", "--run", "run-1", "--station", "dim-station-build"];

function queued(database: Database): void {
  runOrderCommand(database, add);
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
    expect(snapshot.orders[0]?.status).toBe("queued");
  });

  test("a claim moves it into the active column", () => {
    const database = db();
    queued(database);

    expect(runOrderCommand(database, claim)).toBe("order-1 is working");

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 1, done: 0 });
    expect(snapshot.orders[0]?.status).toBe("working");
    expect(snapshot.orders[0]?.station).toBe("build");
  });

  test("an order keeps the description it was queued with", () => {
    const database = db();

    queued(database);
    runOrderCommand(database, claim);

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

  test("a move sends the card to the station the work is at now", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(runOrderCommand(database, ["move", "order-1", "--station", "dim-station-review"])).toBe(
      "order-1 moved to dim-station-review",
    );

    expect(assembleWallSnapshot(database).orders[0]?.station).toBe("review");
  });

  test("a move with no station to move to is refused", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(() => runOrderCommand(database, ["move", "order-1"])).toThrow(OrderCommandError);

    expect(assembleWallSnapshot(database).orders[0]?.station).toBe("build");
  });

  test("a ship lands the order's own commits on the trunk", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);
    const wt = join(trunk.dir, ".claude", "worktrees", "order-1");
    writeFileSync(join(wt, "ship-a.txt"), "a");
    Bun.spawnSync(["git", "-C", wt, "add", "."]);
    Bun.spawnSync(["git", "-C", wt, "commit", "-q", "-m", "feat: ship-a"]);
    const sha = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], { stdout: "pipe" })
      .stdout.toString()
      .trim();
    runOrderCommand(database, ["commit", "order-1", "--sha", sha, "--subject", "feat: ship-a"]);

    expect(runOrderCommand(database, ["ship", "order-1"], null, wt)).toBe(
      "order-1 is fast-forwarded onto the trunk",
    );

    expect(Bun.spawnSync(["git", "-C", trunk.dir, "merge-base", "--is-ancestor", sha, "HEAD"]).success).toBe(
      true,
    );
    runOrderCommand(database, ["check", "order-1", "--command", "bun run verify", "--exit", "0"]);
    expect(runOrderCommand(database, ["stop", "order-1", "completed"], null, trunk.dir)).toBe(
      "order-1 is completed",
    );
  });

  test("a ship run from the trunk checkout still lands the order's branch", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);
    const wt = join(trunk.dir, ".claude", "worktrees", "order-1");
    writeFileSync(join(wt, "ship-b.txt"), "b");
    Bun.spawnSync(["git", "-C", wt, "add", "."]);
    Bun.spawnSync(["git", "-C", wt, "commit", "-q", "-m", "feat: ship-b"]);
    const sha = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], { stdout: "pipe" })
      .stdout.toString()
      .trim();
    runOrderCommand(database, ["commit", "order-1", "--sha", sha, "--subject", "feat: ship-b"]);

    expect(runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toBe(
      "order-1 is fast-forwarded onto the trunk",
    );

    expect(Bun.spawnSync(["git", "-C", trunk.dir, "merge-base", "--is-ancestor", sha, "HEAD"]).success).toBe(
      true,
    );
  });

  test("a ship of a commit already on the trunk reports it as already landed", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);
    landed(database, "order-1");

    expect(runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toBe(
      "order-1 is already on the trunk",
    );
  });

  test("a ship is refused before the order recorded any commit", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(() => runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toThrow(
      expect.objectContaining({ code: "order_not_integrated" }),
    );
  });

  test("a ship is refused before the order is claimed", () => {
    const database = db();
    queued(database);

    expect(() => runOrderCommand(database, ["ship", "order-1"], null, trunk.dir)).toThrow(
      "order order-1 is not claimed",
    );
  });

  test("a stop moves that card into the done column", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);
    landed(database, "order-1");

    expect(runOrderCommand(database, ["stop", "order-1", "completed"], null, trunk.dir)).toBe(
      "order-1 is completed",
    );

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 0, done: 1 });
    expect(snapshot.orders[0]?.status).toBe("completed");
  });

  test("a stop as completed is refused until a check has passed", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);
    runOrderCommand(database, ["check", "order-1", "--command", "bun run verify", "--exit", "1"]);

    expect(() => runOrderCommand(database, ["stop", "order-1", "completed"], null, trunk.dir)).toThrow(
      expect.objectContaining({ code: "order_not_checked" }),
    );

    expect(assembleWallSnapshot(database).orders[0]?.status).toBe("working");
    expect(runOrderCommand(database, ["stop", "order-1", "failed", "--reason", "waits on the wall"])).toBe(
      "order-1 is queued again",
    );
  });

  test("a failure puts the order back among the work nobody holds", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    runOrderCommand(database, ["stop", "order-1", "failed", "--reason", "the check never passed"]);

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 1, active: 0, done: 0 });
    expect(snapshot.orders[0]?.status).toBe("queued");
    // Taking it again is the same act as taking one that never started.
    expect(runOrderCommand(database, claim)).toBe("order-1 is working");
  });

  test("a held order is refused to a claim until the owner releases it", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, ["hold", "order-1", "--reason", "outward-facing"]);

    expect(() => runOrderCommand(database, claim)).toThrow(/outward-facing/);

    runOrderCommand(database, ["release", "order-1"]);
    expect(runOrderCommand(database, claim)).toBe("order-1 is working");
  });

  test("ready lists the unheld orders most urgent first, held ones apart", () => {
    const database = db();
    runOrderCommand(database, add);
    runOrderCommand(database, ["add", "order-2", "--title", "Later", "--project", "cniska/dim-factory"]);
    runOrderCommand(database, ["priority", "order-2", "urgent"]);
    runOrderCommand(database, [
      "add",
      "order-3",
      "--title",
      "Owner's",
      "--project",
      "cniska/dim-factory",
      "--hold",
      "outward-facing",
    ]);

    const read = JSON.parse(runOrderCommand(database, ["ready", "--project", "cniska/dim-factory"]));

    expect(read.ready.map((one: { id: string }) => one.id)).toEqual(["order-2", "order-1"]);
    expect(read.held.map((one: { id: string }) => one.id)).toEqual(["order-3"]);
  });

  test("a running order records the evidence the work produced", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(
      runOrderCommand(database, ["commit", "order-1", "--sha", "abc123", "--subject", "feat: land it"]),
    ).toBe("order-1 recorded commit abc123");
    expect(
      runOrderCommand(database, [
        "file",
        "order-1",
        "--path",
        "src/order-command.ts",
        "--added",
        "31",
        "--removed",
        "4",
      ]),
    ).toBe("order-1 recorded src/order-command.ts (+31/-4)");
    expect(
      runOrderCommand(database, [
        "check",
        "order-1",
        "--command",
        "bun run verify",
        "--exit",
        "0",
        "--result",
        "green",
      ]),
    ).toMatch(/^order-1 recorded bun run verify \(0\)$/);
    expect(
      runOrderCommand(
        database,
        ["finding", "order-1", "--dimension", "tests", "--summary", "the invariant holds"],
        null,
        trunk.dir,
        reviewerEnv(database, "order-1"),
      ),
    ).toBe("order-1 raised finding 1 on tests");
    expect(runOrderCommand(database, ["answer", "1", "--answer", "fixed"])).toBe("finding 1 is fixed");
    expect(runOrderCommand(database, ["document", "order-1", "--path", "docs/factory.md"])).toBe(
      "order-1 recorded docs/factory.md",
    );

    expect(database.query("SELECT sha, subject FROM factory_order_commit").get()).toEqual({
      sha: "abc123",
      subject: "feat: land it",
    });
    expect(database.query("SELECT path, added, removed FROM factory_order_file").get()).toEqual({
      path: "src/order-command.ts",
      added: 31,
      removed: 4,
    });
    expect(database.query("SELECT command, exit_code, result FROM factory_order_check").get()).toEqual({
      command: "bun run verify",
      exit_code: 0,
      result: "green",
    });
    expect(database.query("SELECT dimension, summary, answer FROM factory_order_finding").get()).toEqual({
      dimension: "tests",
      summary: "the invariant holds",
      answer: "fixed",
    });
    expect(database.query("SELECT path FROM factory_order_document").get()).toEqual({
      path: "docs/factory.md",
    });
  });

  test("evidence is refused before the order is claimed and after it stopped", () => {
    const database = db();
    queued(database);

    expect(() => runOrderCommand(database, ["commit", "order-1", "--sha", "abc123"])).toThrow(
      "order order-1 is not claimed",
    );

    runOrderCommand(database, claim);
    landed(database, "order-1");
    runOrderCommand(database, ["stop", "order-1", "completed"], null, trunk.dir);

    expect(() => runOrderCommand(database, ["commit", "order-1", "--sha", "abc123"])).toThrow(
      "order order-1 is already completed",
    );
    expect(
      database.query("SELECT count(*) AS rows FROM factory_order_commit WHERE sha = 'abc123'").get(),
    ).toEqual({ rows: 0 });
  });

  test("a line count that is not a number is refused, and git's binary dash is no count", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    for (const spec of ["", " ", "1e3", "-4", "many"]) {
      expect(() =>
        runOrderCommand(database, ["file", "order-1", "--path", "src/a.ts", "--added", spec]),
      ).toThrow(OrderCommandError);
    }
    expect(
      runOrderCommand(database, [
        "file",
        "order-1",
        "--path",
        "src/logo.png",
        "--added",
        "-",
        "--removed",
        "-",
      ]),
    ).toBe("order-1 recorded src/logo.png");
    expect(database.query("SELECT added, removed FROM factory_order_file").get()).toEqual({
      added: null,
      removed: null,
    });
  });

  test("a check with no exit status and a finding with no answer are refused", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(() =>
      runOrderCommand(database, ["check", "order-1", "--command", "bun run verify", "--exit", "green"]),
    ).toThrow(OrderCommandError);
    runOrderCommand(
      database,
      ["finding", "order-1", "--dimension", "tests", "--summary", "s"],
      null,
      trunk.dir,
      reviewerEnv(database, "order-1"),
    );
    expect(() => runOrderCommand(database, ["answer", "1", "--answer", "maybe"])).toThrow(OrderCommandError);
    expect(() => runOrderCommand(database, ["answer", "nope", "--answer", "fixed"])).toThrow(
      OrderCommandError,
    );
    for (const spec of ["", " ", "1e3"]) {
      expect(() =>
        runOrderCommand(database, ["check", "order-1", "--command", "bun run verify", "--exit", spec]),
      ).toThrow(OrderCommandError);
    }

    expect(database.query("SELECT count(*) AS rows FROM factory_order_check").get()).toEqual({ rows: 0 });
    expect(database.query("SELECT answer FROM factory_order_finding").get()).toEqual({ answer: null });
  });

  test("a refused finding is not answered without the grounds it rests on", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);
    runOrderCommand(
      database,
      ["finding", "order-1", "--dimension", "docs", "--summary", "a doc did not move"],
      null,
      trunk.dir,
      reviewerEnv(database, "order-1"),
    );

    expect(() => runOrderCommand(database, ["answer", "1", "--answer", "refused"])).toThrow(
      expect.objectContaining({ code: "SQLITE_CONSTRAINT_CHECK" }),
    );

    expect(database.query("SELECT answer FROM factory_order_finding WHERE id = 1").get()).toEqual({
      answer: null,
    });
  });

  // Answering is a reply to one thing a reviewer said, and a second reply would rewrite a
  // judgement the record may already have been read for.
  test("a finding is answered once", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);
    runOrderCommand(
      database,
      ["finding", "order-1", "--dimension", "tests", "--summary", "thin"],
      null,
      trunk.dir,
      reviewerEnv(database, "order-1"),
    );
    runOrderCommand(database, ["answer", "1", "--answer", "fixed"]);

    expect(() =>
      runOrderCommand(database, ["answer", "1", "--answer", "refused", "--resolution", "no"]),
    ).toThrow(/already fixed/);
    expect(database.query("SELECT answer FROM factory_order_finding WHERE id = 1").get()).toEqual({
      answer: "fixed",
    });
  });

  test("a way an order cannot stop is refused rather than written", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

    expect(() => runOrderCommand(database, ["stop", "order-1", "working"])).toThrow(OrderCommandError);

    expect(assembleWallSnapshot(database).orders[0]?.status).toBe("working");
    landed(database, "order-1");
    expect(runOrderCommand(database, ["stop", "order-1", "completed"], null, trunk.dir)).toBe(
      "order-1 is completed",
    );
  });

  test("an order queued without a title is refused before any row is written", () => {
    const database = db();

    expect(() => runOrderCommand(database, ["add", "order-1", "--project", "cniska/dim-factory"])).toThrow(
      OrderCommandError,
    );
    expect(assembleWallSnapshot(database).orders).toEqual([]);
  });

  test("a claim onto a stopped floor is refused with the reason the floor was stopped for", () => {
    const database = db();
    pullStop(database, { reason: "the commit gate records nothing" });

    expect(() => runOrderCommand(database, claim)).toThrow(/the commit gate records nothing/);
    expect(assembleWallSnapshot(database).orders).toEqual([]);
  });

  test("a claim is refused on a machine whose session hooks were never installed", () => {
    const database = db();
    queued(database);
    const bare = mkdtempSync(join(tmpdir(), "dim-bare-"));

    expect(() => runCommand(database, claim, null, undefined, { ...env, ...scratchEnv(bare) })).toThrow(
      expect.objectContaining({ code: "hooks_missing" }),
    );
    expect(assembleWallSnapshot(database).totals).toEqual({ todo: 1, active: 0, done: 0 });
    rmSync(bare, { recursive: true, force: true });
  });

  test("a claim is refused where a session hook is written against an older contract", () => {
    const database = db();
    queued(database);
    const older = collectingMachine();
    for (const tool of TOOLS) {
      const config = hookConfigPath(tool, older.env);
      writeFileSync(config, readFileSync(config, "utf8").replaceAll(/dim-hook:\d+/g, "dim-hook:1"));
    }

    expect(() => runCommand(database, claim, null, undefined, { ...env, ...older.env })).toThrow(
      expect.objectContaining({ code: "hooks_stale" }),
    );
    expect(assembleWallSnapshot(database).totals).toEqual({ todo: 1, active: 0, done: 0 });
    rmSync(older.dir, { recursive: true, force: true });
  });

  test("every write is refused where nothing says which worker is making it", () => {
    const database = db();
    queued(database);
    const unissued = { ...env, DIM_WORKER_TOKEN: "not the one it was handed" };

    for (const args of [
      add,
      claim,
      ["move", "order-1", "--station", "review"],
      ["stop", "order-1", "failed"],
    ]) {
      expect(() => runCommand(database, args, null, undefined, {})).toThrow(
        expect.objectContaining({ code: "worker_missing" }),
      );
      expect(() => runCommand(database, args, null, undefined, unissued)).toThrow(
        expect.objectContaining({ code: "worker_unissued" }),
      );
    }
    // Nothing was written by any of them, which is the point: a refused write is not a
    // moment the log has to describe afterwards.
    expect(database.query("SELECT count(*) AS n FROM factory_order_event").get()).toEqual({ n: 1 });
  });

  test("an unknown subcommand, an unknown flag and a repeated flag are refused", () => {
    const database = db();

    expect(() => runOrderCommand(database, ["park", "order-1"])).toThrow(OrderCommandError);
    expect(() => runOrderCommand(database, ["toString", "order-1"])).toThrow(OrderCommandError);
    expect(() => runOrderCommand(database, [...claim, "--colour", "red"])).toThrow(OrderCommandError);
    expect(() => runOrderCommand(database, [...claim, "--title", "second"])).toThrow(OrderCommandError);
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

    expect(() => runOrderCommand(database, ["amend", "order-1"])).toThrow(OrderCommandError);
  });

  test("an amend is refused once the order is claimed", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

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

    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      status: "dropped",
    });
    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 0, done: 0 });
    expect(snapshot.orders).toEqual([]);
  });

  test("a drop needs a reason", () => {
    const database = db();
    queued(database);

    expect(() =>
      runOrderCommand(database, ["drop", "order-1"], null, trunk.dir, operatorEnv(database)),
    ).toThrow(OrderCommandError);
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
    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      status: "queued",
    });
  });

  test("a drop is refused while a hand is holding the order", () => {
    const database = db();
    queued(database);
    runOrderCommand(database, claim);

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

  test("a dropped order cannot be claimed, amended or dropped again", () => {
    const database = db();
    queued(database);
    runOrderCommand(
      database,
      ["drop", "order-1", "--reason", "not worth building"],
      null,
      trunk.dir,
      operatorEnv(database),
    );

    expect(() => runOrderCommand(database, claim)).toThrow();
    expect(() => runOrderCommand(database, ["amend", "order-1", "--title", "too late"])).toThrow(
      expect.objectContaining({ code: "order_not_queued" }),
    );
    // Dropped is terminal, so a second drop meets that refusal rather than order_not_queued.
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
