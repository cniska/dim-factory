import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { clearStop, FactoryStopError, liveStop, pullStop } from "./factory-stop";
import { SCHEMA_SQL } from "./schema";

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
  test("a pulled stop is the live one, and names the order it came from", () => {
    const db = floor();

    pullStop(db, { reason: "the wall serves code older than the database", orderId: "order-1" });

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
    pullStop(db, { reason: "the wall serves code older than the database" });

    expect(() => pullStop(db, { reason: "and the gate records nothing" })).toThrow(
      expect.objectContaining({ code: "already_live" }),
    );

    db.close();
  });

  test("a stop with no reason is refused before it reaches the table", () => {
    const db = floor();

    expect(() => pullStop(db, { reason: "   " })).toThrow(
      expect.objectContaining({ code: "reason_missing" }),
    );
    expect(db.query("SELECT count(*) AS n FROM factory_stop").get()).toEqual({ n: 0 });
    db.close();
  });

  test("clearing returns the defect the floor was held for, and frees the next stop", () => {
    const db = floor();
    pullStop(db, { reason: "the wall serves code older than the database" });

    const cleared = clearStop(db, "owner");

    expect(cleared.reason).toBe("the wall serves code older than the database");
    expect(liveStop(db)).toBeUndefined();
    expect(() => pullStop(db, { reason: "and the gate records nothing" })).not.toThrow();
    db.close();
  });

  test("clearing a floor that is running is refused", () => {
    const db = floor();

    expect(() => clearStop(db)).toThrow(expect.objectContaining({ code: "none_live" }));

    db.close();
  });

  test("a refusal carries its code, not just its words", () => {
    const db = floor();
    pullStop(db, { reason: "the wall serves code older than the database" });

    try {
      pullStop(db, { reason: "and the gate records nothing" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FactoryStopError);
      expect((error as FactoryStopError).code).toBe("already_live");
    }
    db.close();
  });
});
