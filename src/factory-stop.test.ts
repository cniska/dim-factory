import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import { runFactoryCommand } from "./factory-command";
import { clearStop, FactoryStopError, liveStop, pullStop } from "./factory-stop";
import { mintWorker, WORKER_NAME_VAR, WORKER_TOKEN_VAR } from "./worker";

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

function pull(db: Database, reason: string): void {
  db.run("INSERT INTO factory_stop (reason, pulled_by, pulled_at) VALUES (?, 'operator', ?)", [
    reason,
    "2026-09-19T09:00:00.000Z",
  ]);
}

describe("stopping the factory", () => {
  test("refuses a second stop while one is live", () => {
    const db = floor();
    pull(db, "the commit gate records nothing");

    expect(() => pull(db, "and the wall is stale too")).toThrow(/UNIQUE/);

    db.close();
  });

  test("takes a new stop once the last one is cleared", () => {
    const db = floor();
    pull(db, "the commit gate records nothing");
    db.run("UPDATE factory_stop SET cleared_at = '2026-09-19T10:00:00.000Z', cleared_by = 'operator'");

    pull(db, "and the wall is stale too");

    expect(db.query("SELECT count(*) AS n FROM factory_stop").get()).toEqual({ n: 2 });
    expect(db.query("SELECT reason FROM factory_stop WHERE cleared_at IS NULL").all()).toEqual([
      { reason: "and the wall is stale too" },
    ]);
    db.close();
  });

  test("refuses a stop that says nothing about why", () => {
    const db = floor();

    expect(() => pull(db, "   ")).toThrow(/CHECK/);

    db.close();
  });

  test("refuses a clearing that says who but not when", () => {
    const db = floor();
    pull(db, "the commit gate records nothing");

    expect(() => db.run("UPDATE factory_stop SET cleared_by = 'operator'")).toThrow(/CHECK/);

    db.close();
  });
});

describe("pulling and clearing a stop", () => {
  test("a worker cannot clear a stop or claim another puller", () => {
    const db = floor();
    const operator = mintWorker(db, { role: "operator", sessionId: "operator-session" });
    const builder = mintWorker(db, { role: "builder", sessionId: "builder-session" });
    const operatorEnv = { [WORKER_NAME_VAR]: operator.name, [WORKER_TOKEN_VAR]: operator.token };
    const builderEnv = { [WORKER_NAME_VAR]: builder.name, [WORKER_TOKEN_VAR]: builder.token };

    expect(() => runFactoryCommand(db, ["stop", "--reason", "broken"], {})).toThrow(
      expect.objectContaining({ code: "worker_missing" }),
    );
    expect(() =>
      runFactoryCommand(db, ["stop", "--reason", "broken", "--by", operator.name], builderEnv),
    ).toThrow();
    expect(runFactoryCommand(db, ["stop", "--reason", "broken"], builderEnv)).toMatchObject({
      by: builder.name,
    });
    expect(() => runFactoryCommand(db, ["clear"], builderEnv)).toThrow(
      expect.objectContaining({ code: "worker_not_operator" }),
    );
    expect(liveStop(db)?.pulledBy).toBe(builder.name);
    expect(runFactoryCommand(db, ["clear"], operatorEnv)).toMatchObject({ action: "cleared" });
    db.close();
  });
  test("a pulled stop is the live one, and names the order it came from", () => {
    const db = floor();

    pullStop(db, {
      reason: "the wall serves code older than the database",
      by: "operator",
      orderId: "order-1",
    });

    expect(liveStop(db)).toMatchObject({
      reason: "the wall serves code older than the database",
      pulledBy: "operator",
      orderId: "order-1",
    });
    db.close();
  });

  test("nothing is live on a floor nobody has stopped", () => {
    const db = floor();

    expect(liveStop(db)).toBeUndefined();

    db.close();
  });

  test("a second stop is refused while one is live", () => {
    const db = floor();
    pullStop(db, { reason: "the wall serves code older than the database", by: "operator" });

    expect(() => pullStop(db, { reason: "and the gate records nothing", by: "operator" })).toThrow(
      expect.objectContaining({ code: "already_live" }),
    );

    db.close();
  });

  test("a stop with no reason is refused before it reaches the table", () => {
    const db = floor();

    expect(() => pullStop(db, { reason: "   ", by: "operator" })).toThrow(
      expect.objectContaining({ code: "reason_missing" }),
    );
    expect(db.query("SELECT count(*) AS n FROM factory_stop").get()).toEqual({ n: 0 });
    db.close();
  });

  test("clearing returns the defect the floor was held for, and frees the next stop", () => {
    const db = floor();
    pullStop(db, { reason: "the wall serves code older than the database", by: "operator" });

    const operator = mintWorker(db, { role: "operator", sessionId: "clear-session" });
    const cleared = clearStop(db, operator.name);

    expect(cleared.reason).toBe("the wall serves code older than the database");
    expect(liveStop(db)).toBeUndefined();
    expect(() => pullStop(db, { reason: "and the gate records nothing", by: "operator" })).not.toThrow();
    db.close();
  });

  test("clearing a floor that is running is refused", () => {
    const db = floor();

    expect(() => clearStop(db, "operator")).toThrow(expect.objectContaining({ code: "none_live" }));

    db.close();
  });

  test("a refusal carries its code, not just its words", () => {
    const db = floor();
    pullStop(db, { reason: "the wall serves code older than the database", by: "operator" });

    try {
      pullStop(db, { reason: "and the gate records nothing", by: "operator" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FactoryStopError);
      expect((error as FactoryStopError).code).toBe("already_live");
    }
    db.close();
  });
});
