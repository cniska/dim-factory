import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { runFactoryJob } from "./factory-driver";
import {
  appendJobEvent,
  createJob,
  recordJobCheck,
  recordJobCommit,
  recordJobDocument,
  recordJobEnvironment,
  recordJobFile,
  recordJobFinding,
  updateJobLocation,
} from "./factory-job";
import { dbPath } from "./paths";
import { SCHEMA_SQL } from "./schema";
import { rebuild } from "./sync";
import type { WorkerHookReport } from "./worker-environment";

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
  station: "dim-station-build",
};

const setupReport: WorkerHookReport = {
  phase: "setup",
  argv: ["/tmp/wt/scripts/worktree-setup.sh"],
  exitCode: 0,
  signal: null,
  stdout: '{"resources":[{"container":"dim-wt-job-1"}]}\n',
  stderr: "",
  resources: [{ container: "dim-wt-job-1" }],
};

const teardownReport: WorkerHookReport = {
  phase: "teardown",
  argv: ["/tmp/wt/scripts/worktree-teardown.sh"],
  exitCode: null,
  signal: "SIGKILL",
  stdout: "",
  stderr: "out of memory\n",
  resources: [],
};

describe("factory job report records", () => {
  test("runs one item through a builder and records its observable lifecycle", async () => {
    const database = db();
    const result = await runFactoryJob(
      database,
      {
        id: "job-2",
        runId: "run-2",
        queueId: "build-order",
        itemId: "self-sufficient-factory-job",
        agentId: "agent-2",
      },
      { baseRevision: "abc123" },
      async (context) => {
        expect(context.item.itemId).toBe("self-sufficient-factory-job");
        expect(context.baseRevision).toBe("abc123");
        context.setLocation("/tmp/job-2", "job-2");
        context.delegate("agent-3", "session-3", "dim-station-review");
        context.recordCommit("def456", "feat: observable job");
        context.recordFile("src/factory-driver.ts");
        context.recordCheck({ command: "bun run verify", exitCode: 0, result: "green" });
        context.recordFinding({ dimension: "tests", summary: "holds", answer: "fixed" });
        context.recordDocument("docs/factory.md");
        context.recordEnvironment(setupReport);
        context.stop({ status: "completed", reason: "verified" });
        return { status: "completed", reason: "verified" };
      },
    );

    expect(result).toEqual({ status: "completed", reason: "verified" });
    expect(
      database
        .query("SELECT status, stop_reason, worktree, branch FROM factory_job WHERE id = 'job-2'")
        .get(),
    ).toEqual({
      status: "completed",
      stop_reason: "verified",
      worktree: "/tmp/job-2",
      branch: "job-2",
    });
    expect(database.query("SELECT kind, status FROM factory_job_event WHERE job_id = 'job-2'").all()).toEqual(
      [
        { kind: "claimed", status: null },
        { kind: "started", status: "running" },
        { kind: "delegated", status: null },
        { kind: "commit_created", status: null },
        { kind: "check_finished", status: null },
        { kind: "review_finished", status: null },
        { kind: "completed", status: "completed" },
      ],
    );
    expect(database.query("SELECT sha FROM factory_job_commit WHERE job_id = 'job-2'").get()).toEqual({
      sha: "def456",
    });
    expect(database.query("SELECT path FROM factory_job_file WHERE job_id = 'job-2'").get()).toEqual({
      path: "src/factory-driver.ts",
    });
    expect(database.query("SELECT command FROM factory_job_check WHERE job_id = 'job-2'").get()).toEqual({
      command: "bun run verify",
    });
    expect(database.query("SELECT dimension FROM factory_job_finding WHERE job_id = 'job-2'").get()).toEqual({
      dimension: "tests",
    });
    expect(database.query("SELECT path FROM factory_job_document WHERE job_id = 'job-2'").get()).toEqual({
      path: "docs/factory.md",
    });
    expect(
      database.query("SELECT phase, resources FROM factory_job_environment WHERE job_id = 'job-2'").get(),
    ).toEqual({ phase: "setup", resources: '[{"container":"dim-wt-job-1"}]' });
    database.close();
  });

  test("projects every returned terminal outcome", async () => {
    const database = db();
    for (const [index, status] of (
      ["completed", "blocked", "fenced", "failed", "abandoned"] as const
    ).entries()) {
      const jobId = `job-terminal-${index}`;
      const outcome = await runFactoryJob(
        database,
        {
          id: jobId,
          runId: `run-${jobId}`,
          queueId: "queue-1",
          itemId: jobId,
          worktree: `/repo/.claude/worktrees/${jobId}`,
          branch: jobId,
        },
        { baseRevision: "abc123" },
        () => ({ status, reason: "stopped" }),
      );
      expect(outcome).toEqual({ status, reason: "stopped" });
      expect(database.query("SELECT status, stop_reason FROM factory_job WHERE id = ?").get(jobId)).toEqual({
        status,
        stop_reason: "stopped",
      });
      expect(
        database.query("SELECT kind, status FROM factory_job_event WHERE job_id = ?").all(jobId),
      ).toEqual([
        { kind: "claimed", status: null },
        { kind: "started", status: "running" },
        { kind: status, status },
      ]);
    }
    database.close();
  });

  test("records a failed builder before rethrowing its error", async () => {
    const database = db();
    await expect(
      runFactoryJob(
        database,
        { id: "job-3", runId: "run-3", queueId: "queue-1", itemId: "item-3" },
        { baseRevision: "abc123" },
        () => {
          throw new Error("builder stopped");
        },
      ),
    ).rejects.toThrow("builder stopped");
    expect(database.query("SELECT status, stop_reason FROM factory_job WHERE id = 'job-3'").get()).toEqual({
      status: "failed",
      stop_reason: "builder stopped",
    });
    expect(database.query("SELECT kind FROM factory_job_event WHERE job_id = 'job-3'").all()).toEqual([
      { kind: "claimed" },
      { kind: "started" },
      { kind: "failed" },
    ]);
    database.close();
  });

  test("requires one worktree before a job can stop", async () => {
    const database = db();

    await expect(
      runFactoryJob(
        database,
        { id: "job-no-worktree", runId: "run-no-worktree", queueId: "queue-1", itemId: "item-1" },
        { baseRevision: "abc123" },
        () => ({ status: "completed", reason: "verified" }),
      ),
    ).rejects.toThrow("job job-no-worktree has no worktree");
    expect(database.query("SELECT status FROM factory_job WHERE id = 'job-no-worktree'").get()).toEqual({
      status: "failed",
    });
    database.close();
  });

  test("keeps the owned worktree and rejects lifecycle events out of order", () => {
    const database = db();
    createJob(database, job, "2026-09-18T10:00:00.000Z");

    expect(() => appendJobEvent(database, "job-1", { kind: "completed", status: "completed" })).toThrow(
      "job job-1 must be running before it can complete",
    );
    appendJobEvent(database, "job-1", { kind: "started", status: "running" });
    expect(() => updateJobLocation(database, "job-1", "/other", "other")).toThrow(
      "job job-1 already owns a worktree",
    );
    database.close();
  });

  test("records an explicit stop and rejects evidence after it", () => {
    const database = db();
    createJob(database, job, "2026-09-18T10:00:00.000Z");
    appendJobEvent(database, "job-1", { kind: "started", status: "running" }, "2026-09-18T10:01:00.000Z");
    appendJobEvent(
      database,
      "job-1",
      { kind: "fenced", status: "fenced", fenceType: "owner-decision", reason: "needs approval" },
      "2026-09-18T10:02:00.000Z",
    );
    expect(() => recordJobFile(database, "job-1", "src/after-stop.ts")).toThrow(
      "job job-1 is already fenced",
    );
    expect(() => recordJobEnvironment(database, "job-1", teardownReport)).toThrow(
      "job job-1 is already fenced",
    );
    expect(() => updateJobLocation(database, "job-1", "/other", "other")).toThrow(
      "job job-1 is already terminal",
    );
    expect(database.query("SELECT count(*) AS count FROM factory_job_file").get()).toEqual({ count: 0 });
    expect(database.query("SELECT count(*) AS count FROM factory_job_environment").get()).toEqual({
      count: 0,
    });
    database.close();
  });

  test("preserves a builder error after the builder records a terminal outcome", async () => {
    const database = db();
    await expect(
      runFactoryJob(
        database,
        {
          id: "job-4",
          runId: "run-4",
          queueId: "queue-1",
          itemId: "item-4",
          worktree: "/repo/.claude/worktrees/job-4",
          branch: "job-4",
        },
        { baseRevision: "abc123" },
        (context) => {
          context.appendEvent({ kind: "blocked", status: "blocked", reason: "builder stopped" });
          throw new Error("builder failed after stopping");
        },
      ),
    ).rejects.toThrow("builder failed after stopping");
    expect(database.query("SELECT status, stop_reason FROM factory_job WHERE id = 'job-4'").get()).toEqual({
      status: "blocked",
      stop_reason: "builder stopped",
    });
    expect(database.query("SELECT kind FROM factory_job_event WHERE job_id = 'job-4'").all()).toEqual([
      { kind: "claimed" },
      { kind: "started" },
      { kind: "blocked" },
    ]);
    database.close();
  });

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
      station: "dim-station-build",
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

  test("attaches a worktree's setup and teardown reports to the job", () => {
    const database = db();
    createJob(database, job, "2026-09-18T10:00:00.000Z");
    appendJobEvent(database, "job-1", { kind: "started", status: "running" }, "2026-09-18T10:01:00.000Z");
    recordJobEnvironment(database, "job-1", setupReport, "2026-09-18T10:02:00.000Z");
    recordJobEnvironment(database, "job-1", teardownReport, "2026-09-18T10:07:00.000Z");

    expect(
      database
        .query(
          `SELECT phase, argv, exit_code, signal, stdout, stderr, resources, recorded_at
           FROM factory_job_environment WHERE job_id = 'job-1' ORDER BY recorded_at`,
        )
        .all(),
    ).toEqual([
      {
        phase: "setup",
        argv: '["/tmp/wt/scripts/worktree-setup.sh"]',
        exit_code: 0,
        signal: null,
        stdout: '{"resources":[{"container":"dim-wt-job-1"}]}\n',
        stderr: "",
        resources: '[{"container":"dim-wt-job-1"}]',
        recorded_at: "2026-09-18T10:02:00.000Z",
      },
      {
        phase: "teardown",
        argv: '["/tmp/wt/scripts/worktree-teardown.sh"]',
        exit_code: null,
        signal: "SIGKILL",
        stdout: "",
        stderr: "out of memory\n",
        resources: "[]",
        recorded_at: "2026-09-18T10:07:00.000Z",
      },
    ]);
    database.close();
  });

  test("rejects lifecycle events after a job reaches a terminal status", () => {
    const database = db();
    for (const [index, status] of (
      ["completed", "blocked", "fenced", "failed", "abandoned"] as const
    ).entries()) {
      const jobId = `job-terminal-${index}`;
      createJob(
        database,
        { ...job, id: jobId, runId: `run-${jobId}`, itemId: jobId },
        "2026-09-18T10:00:00.000Z",
      );
      appendJobEvent(database, jobId, { kind: "started", status: "running" }, "2026-09-18T10:00:30.000Z");
      appendJobEvent(database, jobId, { kind: status, status }, "2026-09-18T10:01:00.000Z");

      expect(() => appendJobEvent(database, jobId, { kind: "started", status: "running" })).toThrow();
      expect(() => appendJobEvent(database, jobId, { kind: "started" })).toThrow();
      expect(database.query("SELECT status, completed_at FROM factory_job WHERE id = ?").get(jobId)).toEqual({
        status,
        completed_at: "2026-09-18T10:01:00.000Z",
      });
      expect(
        database.query("SELECT count(*) AS count FROM factory_job_event WHERE job_id = ?").get(jobId),
      ).toEqual({
        count: 3,
      });
    }
    database.close();
  });

  test("rejects terminal events whose kind and status disagree", () => {
    const database = db();
    createJob(database, job, "2026-09-18T10:00:00.000Z");

    expect(() => appendJobEvent(database, "job-1", { kind: "completed", status: "failed" })).toThrow(
      "terminal event kind must match its status",
    );
    expect(() => appendJobEvent(database, "job-1", { kind: "completed" })).toThrow(
      "terminal event kind must match its status",
    );
    expect(() => appendJobEvent(database, "job-1", { kind: "started", status: "completed" })).toThrow(
      "terminal event status must match its kind",
    );
    expect(() => appendJobEvent(database, "job-1", { kind: "abandoned", status: "completed" })).toThrow(
      "terminal event kind must match its status",
    );
    expect(database.query("SELECT status FROM factory_job WHERE id = 'job-1'").get()).toEqual({
      status: "claimed",
    });
    expect(
      database.query("SELECT count(*) AS count FROM factory_job_event WHERE job_id = 'job-1'").get(),
    ).toEqual({
      count: 1,
    });
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

  test("rolls back evidence when its lifecycle event cannot project", () => {
    const database = db();
    createJob(database, job, "2026-09-18T10:00:00.000Z");
    appendJobEvent(database, "job-1", { kind: "started", status: "running" });
    database.run(
      `CREATE TRIGGER reject_job_evidence_projection BEFORE UPDATE ON factory_job
       BEGIN SELECT RAISE(ABORT, 'projection rejected'); END`,
    );

    expect(() => recordJobCommit(database, "job-1", "abc123", "feat: job")).toThrow("projection rejected");
    expect(database.query("SELECT count(*) AS count FROM factory_job_commit").get()).toEqual({ count: 0 });
    expect(
      database.query("SELECT count(*) AS count FROM factory_job_event WHERE kind = 'commit_created'").get(),
    ).toEqual({
      count: 0,
    });
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
    appendJobEvent(database, "job-1", { kind: "started", status: "running" }, "2026-09-18T10:01:00.000Z");
    recordJobEnvironment(database, "job-1", teardownReport, "2026-09-18T10:02:00.000Z");
    closeDb(database);
    const rebuilt = openDb(dbPath(environment), { forRebuild: true });
    rebuild(rebuilt, environment);
    expect(rebuilt.query("SELECT status FROM factory_job WHERE id = 'job-1'").get()).toEqual({
      status: "running",
    });
    expect(
      rebuilt.query("SELECT phase, signal FROM factory_job_environment WHERE job_id = 'job-1'").get(),
    ).toEqual({ phase: "teardown", signal: "SIGKILL" });
    expect(rebuilt.query("SELECT kind FROM factory_job_event WHERE job_id = 'job-1'").get()).toEqual({
      kind: "claimed",
    });
    closeDb(rebuilt);
    rmSync(home, { recursive: true, force: true });
  });
});
