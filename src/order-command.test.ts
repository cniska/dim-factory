import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { assembleWallSnapshot } from "./factory-wall";
import { integratedRepo } from "./fixtures.test-support";
import { OrderCommandError, runOrderCommand } from "./order-command";
import { SCHEMA_SQL } from "./schema";

// Held so they close: an open handle is finalized by the runtime at exit instead, which is
// where a suite that reported no failures panics anyway.
const opened: Database[] = [];

function db(): Database {
  const database = new Database(":memory:");
  database.run(SCHEMA_SQL);
  opened.push(database);
  return database;
}

const trunk = integratedRepo();
afterAll(() => {
  for (const database of opened) database.close();
  rmSync(trunk.dir, { recursive: true, force: true });
});

/** What the gate wants before an order may complete: a commit on the trunk, then a check that passed. */
function landed(database: Database, orderId: string): void {
  runOrderCommand(database, ["commit", orderId, "--sha", trunk.sha, "--subject", "feat: land it"]);
  runOrderCommand(database, ["check", orderId, "--command", "bun run verify", "--exit", "0"]);
}

const claim = [
  "claim",
  "order-1",
  "--run",
  "run-1",
  "--queue",
  "build-order",
  "--item",
  "record-a-factory-order",
  "--title",
  "Record a factory order as work is taken",
  "--description",
  "The record holds what an item is called and never what it says.",
  "--agent",
  "agent-1",
  "--station",
  "dim-station-build",
  "--worktree",
  trunk.dir,
  "--branch",
  "order-1",
];

describe("order command", () => {
  test("a claim puts one waiting card on the wall under the item's name", () => {
    const database = db();

    expect(runOrderCommand(database, claim)).toBe(
      "claimed order-1 for record-a-factory-order on build-order",
    );

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 1, active: 0, done: 0 });
    expect(snapshot.orders[0]?.title).toBe("Record a factory order as work is taken");
    expect(snapshot.orders[0]?.itemId).toBe("record-a-factory-order");
    expect(snapshot.orders[0]?.status).toBe("waiting");
    expect(snapshot.orders[0]?.station).toBe("build");
  });

  test("a claim keeps the item's description as the queue worded it", () => {
    const database = db();

    runOrderCommand(database, claim);

    expect(database.query("SELECT description FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      description: "The record holds what an item is called and never what it says.",
    });
  });

  test("a claim with no description records the order without one", () => {
    const database = db();
    const at = claim.indexOf("--description");

    runOrderCommand(database, [...claim.slice(0, at), ...claim.slice(at + 2)]);

    expect(database.query("SELECT description FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      description: null,
    });
  });

  test("a start moves that card into the active column", () => {
    const database = db();
    runOrderCommand(database, claim);

    expect(runOrderCommand(database, ["start", "order-1"])).toBe("order-1 is working");

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 1, done: 0 });
    expect(snapshot.orders[0]?.status).toBe("working");
  });

  test("a move sends the card to the station the work is at now", () => {
    const database = db();
    runOrderCommand(database, claim);
    runOrderCommand(database, ["start", "order-1"]);

    expect(runOrderCommand(database, ["move", "order-1", "--station", "dim-station-review"])).toBe(
      "order-1 moved to dim-station-review",
    );

    expect(assembleWallSnapshot(database).orders[0]?.station).toBe("review");
  });

  test("a move with no station to move to is refused", () => {
    const database = db();
    runOrderCommand(database, claim);
    runOrderCommand(database, ["start", "order-1"]);

    expect(() => runOrderCommand(database, ["move", "order-1"])).toThrow(OrderCommandError);

    expect(assembleWallSnapshot(database).orders[0]?.station).toBe("build");
  });

  test("a stop moves that card into the done column", () => {
    const database = db();
    runOrderCommand(database, claim);
    runOrderCommand(database, ["start", "order-1"]);
    landed(database, "order-1");

    expect(runOrderCommand(database, ["stop", "order-1", "completed"])).toBe("order-1 stopped as completed");

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 0, done: 1 });
    expect(snapshot.orders[0]?.status).toBe("completed");
  });

  test("a stop as completed is refused until a check has passed", () => {
    const database = db();
    runOrderCommand(database, claim);
    runOrderCommand(database, ["start", "order-1"]);
    runOrderCommand(database, ["check", "order-1", "--command", "bun run verify", "--exit", "1"]);

    expect(() => runOrderCommand(database, ["stop", "order-1", "completed"])).toThrow(
      expect.objectContaining({ code: "order_not_checked" }),
    );

    expect(assembleWallSnapshot(database).orders[0]?.status).toBe("working");
    expect(runOrderCommand(database, ["stop", "order-1", "blocked", "--reason", "waits on the wall"])).toBe(
      "order-1 stopped as blocked",
    );
  });

  test("a fence keeps the card active and shows why it stopped", () => {
    const database = db();
    runOrderCommand(database, claim);
    runOrderCommand(database, ["start", "order-1"]);

    runOrderCommand(database, ["stop", "order-1", "fenced", "--reason", "outward-facing"]);

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 1, done: 0 });
    expect(snapshot.orders[0]?.status).toBe("fenced");
    expect(snapshot.orders[0]?.attention).toBe("outward-facing");
  });

  test("a running order records the evidence the work produced", () => {
    const database = db();
    runOrderCommand(database, claim);
    runOrderCommand(database, ["start", "order-1"]);

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
    ).toBe("order-1 recorded bun run verify (0)");
    expect(
      runOrderCommand(database, [
        "finding",
        "order-1",
        "--dimension",
        "tests",
        "--summary",
        "the invariant holds",
        "--answer",
        "fixed",
      ]),
    ).toBe("order-1 recorded a fixed finding on tests");
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

  test("evidence is refused before the order started and after it stopped", () => {
    const database = db();
    runOrderCommand(database, claim);

    expect(() => runOrderCommand(database, ["commit", "order-1", "--sha", "abc123"])).toThrow(
      "order order-1 has not started",
    );

    runOrderCommand(database, ["start", "order-1"]);
    landed(database, "order-1");
    runOrderCommand(database, ["stop", "order-1", "completed"]);

    expect(() => runOrderCommand(database, ["commit", "order-1", "--sha", "abc123"])).toThrow(
      "order order-1 is already completed",
    );
    expect(
      database.query("SELECT count(*) AS rows FROM factory_order_commit WHERE sha = 'abc123'").get(),
    ).toEqual({ rows: 0 });
  });

  test("a line count that is not a number is refused, and git's binary dash is no count", () => {
    const database = db();
    runOrderCommand(database, claim);
    runOrderCommand(database, ["start", "order-1"]);

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
    runOrderCommand(database, claim);
    runOrderCommand(database, ["start", "order-1"]);

    expect(() =>
      runOrderCommand(database, ["check", "order-1", "--command", "bun run verify", "--exit", "green"]),
    ).toThrow(OrderCommandError);
    expect(() =>
      runOrderCommand(database, [
        "finding",
        "order-1",
        "--dimension",
        "tests",
        "--summary",
        "s",
        "--answer",
        "maybe",
      ]),
    ).toThrow(OrderCommandError);
    for (const spec of ["", " ", "1e3"]) {
      expect(() =>
        runOrderCommand(database, ["check", "order-1", "--command", "bun run verify", "--exit", spec]),
      ).toThrow(OrderCommandError);
    }

    expect(database.query("SELECT count(*) AS rows FROM factory_order_check").get()).toEqual({ rows: 0 });
    expect(database.query("SELECT count(*) AS rows FROM factory_order_finding").get()).toEqual({ rows: 0 });
  });

  test("a refused finding is not recorded without the grounds it rests on", () => {
    const database = db();
    runOrderCommand(database, claim);
    runOrderCommand(database, ["start", "order-1"]);

    expect(() =>
      runOrderCommand(database, [
        "finding",
        "order-1",
        "--dimension",
        "docs",
        "--summary",
        "a doc did not move",
        "--answer",
        "refused",
      ]),
    ).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_CHECK" }));

    expect(database.query("SELECT count(*) AS rows FROM factory_order_finding").get()).toEqual({ rows: 0 });
  });

  test("a status an order cannot stop at is refused rather than written", () => {
    const database = db();
    runOrderCommand(database, claim);
    runOrderCommand(database, ["start", "order-1"]);

    expect(() => runOrderCommand(database, ["stop", "order-1", "working"])).toThrow(OrderCommandError);

    expect(assembleWallSnapshot(database).orders[0]?.status).toBe("working");
    landed(database, "order-1");
    expect(runOrderCommand(database, ["stop", "order-1", "completed"])).toBe("order-1 stopped as completed");
  });

  test("a claim missing identity is refused before any row is written", () => {
    const database = db();

    expect(() => runOrderCommand(database, ["claim", "order-1", "--run", "run-1"])).toThrow(
      OrderCommandError,
    );
    expect(assembleWallSnapshot(database).orders).toEqual([]);
  });

  test("an unknown subcommand, an unknown flag and a repeated flag are refused", () => {
    const database = db();

    expect(() => runOrderCommand(database, ["park", "order-1"])).toThrow(OrderCommandError);
    expect(() => runOrderCommand(database, ["toString", "order-1"])).toThrow(OrderCommandError);
    expect(() => runOrderCommand(database, [...claim, "--colour", "red"])).toThrow(OrderCommandError);
    expect(() => runOrderCommand(database, [...claim, "--title", "second"])).toThrow(OrderCommandError);
  });
});
