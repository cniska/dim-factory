import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import { turns } from "./query-usage";

test("turn duration percentiles cover one, even, and odd samples", () => {
  for (const [durations, median, p90] of [
    [[1000], 1, 1],
    [[1000, 3000], 2, 3],
    [[1000, 2000, 3000], 2, 3],
    [[1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000], 5.5, 9],
  ] as const) {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    db.run("INSERT INTO session (id, tool) VALUES ('session', 'codex')");
    durations.forEach((duration, index) => {
      db.run("INSERT INTO turn (session_id, turn_id, ts_end, duration_ms) VALUES (?, ?, ?, ?)", [
        "session",
        `turn-${index}`,
        "2026-09-27T00:00:00Z",
        duration,
      ]);
    });

    expect(turns.run(db, { windowColumn: turns.window }).rows).toEqual([
      ["codex", durations.length, median, p90, 0, 0],
    ]);
    db.close();
  }
});
