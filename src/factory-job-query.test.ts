import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  createJob,
  recordJobCheck,
  recordJobCommit,
  recordJobDocument,
  recordJobFile,
  recordJobFinding,
} from "./factory-job";
import { findQuery } from "./queries";
import { SCHEMA_SQL } from "./schema";

describe("factory job query", () => {
  test("returns the aggregate and every evidence kind by job prefix", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createJob(
      db,
      { id: "job-123", runId: "run-1", queueId: "queue-1", itemId: "item-1", station: "dim-build" },
      "2026-09-18T10:00:00.000Z",
    );
    recordJobCommit(db, "job-123", "abc", "feat: report", "2026-09-18T10:01:00.000Z");
    recordJobFile(db, "job-123", "src/factory-job.ts", "2026-09-18T10:01:30.000Z");
    recordJobCheck(
      db,
      "job-123",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:02:00.000Z",
    );
    recordJobFinding(
      db,
      "job-123",
      { dimension: "tests", summary: "holds", answer: "fixed" },
      "2026-09-18T10:03:00.000Z",
    );
    recordJobDocument(db, "job-123", "docs/factory.md", "2026-09-18T10:04:00.000Z");
    const result = findQuery("job")?.run(db, { arg: "job-12" });
    expect(result?.columns).toEqual(["section", "when", "kind", "status", "subject", "evidence"]);
    expect(result?.rows.map((row) => row[0])).toEqual([
      "job",
      "event",
      "event",
      "commit",
      "file",
      "event",
      "check",
      "event",
      "finding",
      "document",
    ]);
    expect(result?.rows[0]?.[4]).toBe("run-1/queue-1/item-1");
    expect(result?.denominator).toContain("job job-123: claimed");
    db.close();
  });

  test("does not turn an unknown job into an empty report", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const result = findQuery("job")?.run(db, { arg: "missing" });
    expect(result?.rows).toEqual([]);
    expect(result?.note).toBe("no job starts with missing");
    db.close();
  });
});
