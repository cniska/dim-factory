import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  createLane,
  recordLaneCheck,
  recordLaneCommit,
  recordLaneDocument,
  recordLaneFinding,
} from "./factory-lane";
import { findQuery } from "./queries";
import { SCHEMA_SQL } from "./schema";

describe("factory lane query", () => {
  test("returns the aggregate and every evidence kind by lane prefix", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createLane(
      db,
      { id: "lane-123", runId: "run-1", queueId: "queue-1", itemId: "item-1", station: "dim-build" },
      "2026-09-18T10:00:00.000Z",
    );
    recordLaneCommit(db, "lane-123", "abc", "feat: report", "2026-09-18T10:01:00.000Z");
    recordLaneCheck(
      db,
      "lane-123",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:02:00.000Z",
    );
    recordLaneFinding(
      db,
      "lane-123",
      { dimension: "tests", summary: "holds", answer: "fixed" },
      "2026-09-18T10:03:00.000Z",
    );
    recordLaneDocument(db, "lane-123", "docs/factory.md", "2026-09-18T10:04:00.000Z");
    const result = findQuery("lane")?.run(db, { arg: "lane-12" });
    expect(result?.columns).toEqual(["section", "when", "kind", "status", "subject", "evidence"]);
    expect(result?.rows.map((row) => row[0])).toEqual([
      "lane",
      "event",
      "event",
      "commit",
      "event",
      "check",
      "event",
      "finding",
      "document",
    ]);
    expect(result?.rows[0]?.[4]).toBe("run-1/queue-1/item-1");
    expect(result?.denominator).toContain("lane lane-123: claimed");
    db.close();
  });

  test("does not turn an unknown lane into an empty report", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const result = findQuery("lane")?.run(db, { arg: "missing" });
    expect(result?.rows).toEqual([]);
    expect(result?.note).toBe("no lane starts with missing");
    db.close();
  });
});
