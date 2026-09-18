import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import {
  appendJobEvent,
  createJob,
  recordJobCheck,
  recordJobCommit,
  recordJobDocument,
  recordJobFile,
  recordJobFinding,
} from "./factory-job";
import { dbPath } from "./paths";
import { SCHEMA_SQL } from "./schema";
import { rebuild } from "./sync";

function db(): Database {
  const database = new Database(":memory:");
  database.run(SCHEMA_SQL);
  return database;
}

const job = {
  id: "job-1",
  runId: "run-1",
  queueId: "queue-1",
  itemId: "item-1",
  agentId: "agent-1",
  sessionId: "session-1",
  worktree: "/tmp/wt",
  branch: "job-1",
  station: "dim-build",
};

describe("factory job report records", () => {
  test("creates a claim and keeps its identity and current status", () => {
    const database = db();
    createJob(database, job, "2026-09-18T10:00:00.000Z");
    expect(
      database
        .query("SELECT run_id, queue_id, item_id, worktree, branch, station, status FROM factory_job")
        .get(),
    ).toEqual({
      run_id: "run-1",
      queue_id: "queue-1",
      item_id: "item-1",
      worktree: "/tmp/wt",
      branch: "job-1",
      station: "dim-build",
      status: "claimed",
    });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'factory_lane%'")
        .all(),
    ).toEqual([]);
    expect(database.query("SELECT kind, actor_id, session_id FROM factory_job_event").get()).toEqual({
      kind: "claimed",
      actor_id: "agent-1",
      session_id: "session-1",
    });
    database.close();
  });

  test("stores normalized evidence and projects terminal status from events", () => {
    const database = db();
    createJob(database, job, "2026-09-18T10:00:00.000Z");
    appendJobEvent(database, "job-1", { kind: "started", status: "running" }, "2026-09-18T10:01:00.000Z");
    recordJobCommit(database, "job-1", "abc123", "feat: job", "2026-09-18T10:02:00.000Z");
    recordJobFile(database, "job-1", "src/factory-job.ts", "2026-09-18T10:02:30.000Z");
    const check = recordJobCheck(
      database,
      "job-1",
      { command: "bun run verify", exitCode: 0, result: "426 tests" },
      "2026-09-18T10:03:00.000Z",
    );
    const finding = recordJobFinding(
      database,
      "job-1",
      { dimension: "tests", summary: "coverage is present", answer: "fixed" },
      "2026-09-18T10:04:00.000Z",
    );
    recordJobDocument(database, "job-1", "docs/factory.md", "2026-09-18T10:05:00.000Z");
    appendJobEvent(
      database,
      "job-1",
      { kind: "completed", status: "completed", reason: "verified", checkId: check, findingId: finding },
      "2026-09-18T10:06:00.000Z",
    );
    expect(database.query("SELECT status, completed_at, stop_reason FROM factory_job").get()).toEqual({
      status: "completed",
      completed_at: "2026-09-18T10:06:00.000Z",
      stop_reason: "verified",
    });
    expect(database.query("SELECT sha FROM factory_job_commit").get()).toEqual({ sha: "abc123" });
    expect(database.query("SELECT path FROM factory_job_file").get()).toEqual({
      path: "src/factory-job.ts",
    });
    expect(database.query("SELECT command, exit_code FROM factory_job_check").get()).toEqual({
      command: "bun run verify",
      exit_code: 0,
    });
    expect(database.query("SELECT dimension, answer FROM factory_job_finding").get()).toEqual({
      dimension: "tests",
      answer: "fixed",
    });
    expect(database.query("SELECT path FROM factory_job_document").get()).toEqual({
      path: "docs/factory.md",
    });
    database.close();
  });

  test("rejects lifecycle events after a job reaches a terminal status", () => {
    const database = db();
    createJob(database, job, "2026-09-18T10:00:00.000Z");
    appendJobEvent(database, "job-1", { kind: "completed", status: "completed" }, "2026-09-18T10:01:00.000Z");

    expect(() =>
      appendJobEvent(database, "job-1", { kind: "started", status: "running" }, "2026-09-18T10:02:00.000Z"),
    ).toThrow();
    expect(() =>
      appendJobEvent(database, "job-1", { kind: "started" }, "2026-09-18T10:03:00.000Z"),
    ).toThrow();
    expect(database.query("SELECT status, completed_at FROM factory_job").get()).toEqual({
      status: "completed",
      completed_at: "2026-09-18T10:01:00.000Z",
    });
    expect(database.query("SELECT count(*) AS count FROM factory_job_event").get()).toEqual({ count: 2 });
    database.close();
  });

  test("rolls back an event when projecting it fails", () => {
    const database = db();
    createJob(database, job, "2026-09-18T10:00:00.000Z");
    database.run(
      `CREATE TRIGGER reject_job_projection BEFORE UPDATE ON factory_job
       BEGIN SELECT RAISE(ABORT, 'projection rejected'); END`,
    );

    expect(() =>
      appendJobEvent(database, "job-1", { kind: "started", status: "running" }, "2026-09-18T10:01:00.000Z"),
    ).toThrow();
    expect(database.query("SELECT count(*) AS count FROM factory_job_event").get()).toEqual({ count: 1 });
    expect(database.query("SELECT status FROM factory_job").get()).toEqual({ status: "claimed" });
    database.close();
  });

  test("refused findings require a resolution", () => {
    const database = db();
    createJob(database, job);
    expect(() =>
      recordJobFinding(database, "job-1", { dimension: "docs", summary: "missing", answer: "refused" }),
    ).toThrow();
    database.close();
  });

  test("keeps the report through rebuild because no source can recreate it", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-job-"));
    const environment = { HOME: home, DIM_HOME: home };
    const database = openDb(dbPath(environment));
    createJob(database, job, "2026-09-18T10:00:00.000Z");
    closeDb(database);
    const rebuilt = openDb(dbPath(environment), { forRebuild: true });
    rebuild(rebuilt, environment);
    expect(rebuilt.query("SELECT status FROM factory_job WHERE id = 'job-1'").get()).toEqual({
      status: "claimed",
    });
    expect(rebuilt.query("SELECT kind FROM factory_job_event WHERE job_id = 'job-1'").get()).toEqual({
      kind: "claimed",
    });
    closeDb(rebuilt);
    rmSync(home, { recursive: true, force: true });
  });
});
