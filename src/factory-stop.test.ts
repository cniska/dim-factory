import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
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
    // Each pull is its own row, so what stopped the floor in March is still
    // readable after it was cleared.
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
