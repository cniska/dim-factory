import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  appendJobEvent,
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
  test("returns one unified status row with the latest lifecycle and evidence", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createJob(
      db,
      {
        id: "job-status",
        runId: "run-1",
        queueId: "queue-1",
        itemId: "item-1",
        worktree: "/tmp/factory-item",
        branch: "factory-item",
        station: "dim-station-build",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendJobEvent(db, "job-status", { kind: "started", status: "running" }, "2026-09-18T10:01:00.000Z");
    recordJobCommit(db, "job-status", "abc123", "feat: status", "2026-09-18T10:02:00.000Z");
    recordJobCommit(db, "job-status", "def456", "feat: later", "2026-09-18T10:02:00.000Z");
    recordJobCheck(
      db,
      "job-status",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:03:00.000Z",
    );
    recordJobCheck(
      db,
      "job-status",
      { command: "bun run test", exitCode: 0, result: "green" },
      "2026-09-18T10:03:00.000Z",
    );
    recordJobFinding(
      db,
      "job-status",
      { dimension: "tests", summary: "holds", answer: "fixed" },
      "2026-09-18T10:04:00.000Z",
    );
    recordJobFinding(
      db,
      "job-status",
      { dimension: "docs", summary: "updated", answer: "fixed" },
      "2026-09-18T10:04:00.000Z",
    );
    appendJobEvent(
      db,
      "job-status",
      { kind: "completed", status: "completed", reason: "verified" },
      "2026-09-18T10:05:00.000Z",
    );

    const before = [
      "factory_job",
      "factory_job_event",
      "factory_job_commit",
      "factory_job_file",
      "factory_job_check",
      "factory_job_finding",
      "factory_job_document",
    ].map((table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
    const result = findQuery("factory")?.run(db, { arg: "job-st" });

    expect(result?.columns).toEqual([
      "queue",
      "item",
      "job",
      "status",
      "latest_event",
      "latest_event_at",
      "worktree",
      "branch",
      "station",
      "commit",
      "check",
      "findings",
      "stop",
    ]);
    expect(result?.rows).toEqual([
      [
        "queue-1",
        "item-1",
        "job-status",
        "completed",
        "completed",
        "2026-09-18T10:05:00.000Z",
        "/tmp/factory-item",
        "factory-item",
        "dim-station-build",
        "def456 feat: later",
        "bun run test (0, green)",
        "tests: fixed - holds; docs: fixed - updated",
        "verified",
      ],
    ]);
    expect(result?.denominator).toContain("queue planner source absent");
    const after = [
      "factory_job",
      "factory_job_event",
      "factory_job_commit",
      "factory_job_file",
      "factory_job_check",
      "factory_job_finding",
      "factory_job_document",
    ].map((table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
    expect(after).toEqual(before);
    db.close();
  });

  test("shows explicit absence when a blocked job has no fence or reason", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createJob(db, { id: "job-blocked", runId: "run-1", queueId: "queue-1", itemId: "item-1" });
    appendJobEvent(db, "job-blocked", { kind: "blocked", status: "blocked" });

    const result = findQuery("factory")?.run(db, { arg: "job-blocked" });

    expect(result?.rows[0]?.[3]).toBe("blocked");
    expect(result?.rows[0]?.[4]).toBe("blocked");
    expect(result?.rows[0]?.[12]).toBe("(none)");

    createJob(db, { id: "job-fenced", runId: "run-1", queueId: "queue-1", itemId: "item-2" });
    appendJobEvent(db, "job-fenced", {
      kind: "fenced",
      status: "fenced",
      fenceType: "owner-judgment",
      reason: "ambiguous scope",
    });
    const fenced = findQuery("factory")?.run(db, { arg: "job-fenced" });
    expect(fenced?.rows[0]?.[12]).toBe("owner-judgment: ambiguous scope");
    db.close();
  });

  test("returns the aggregate and every evidence kind by job prefix", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createJob(
      db,
      { id: "job-123", runId: "run-1", queueId: "queue-1", itemId: "item-1", station: "dim-station-build" },
      "2026-09-18T10:00:00.000Z",
    );
    appendJobEvent(db, "job-123", { kind: "started", status: "running" }, "2026-09-18T10:00:30.000Z");
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
    expect(result?.denominator).toContain("job job-123: running");
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

  test("reports absent queue planning without inventing queue rows", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);

    const result = findQuery("factory")?.run(db, {});

    expect(result?.rows).toEqual([]);
    expect(result?.denominator).toContain("queue planner source absent");
    expect(result?.note).toBe("no factory jobs are recorded");
    db.close();
  });
});
