import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { assembleWallSnapshot } from "./factory-wall";
import { integratedRepo } from "./fixtures.test-support";
import { JobCommandError, runJobCommand } from "./job-command";
import { SCHEMA_SQL } from "./schema";

function db(): Database {
  const database = new Database(":memory:");
  database.run(SCHEMA_SQL);
  return database;
}

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

/** What the gate wants before a job may complete: a commit on the trunk, then a check that passed. */
function landed(database: Database, jobId: string): void {
  runJobCommand(database, ["commit", jobId, "--sha", trunk.sha, "--subject", "feat: land it"]);
  runJobCommand(database, ["check", jobId, "--command", "bun run verify", "--exit", "0"]);
}

const claim = [
  "claim",
  "job-1",
  "--run",
  "run-1",
  "--queue",
  "build-order",
  "--item",
  "record-a-factory-job",
  "--title",
  "Record a factory job as work is taken",
  "--description",
  "The record holds what an item is called and never what it says.",
  "--agent",
  "agent-1",
  "--station",
  "dim-station-build",
  "--worktree",
  trunk.dir,
  "--branch",
  "job-1",
];

describe("job command", () => {
  test("a claim puts one waiting card on the wall under the item's name", () => {
    const database = db();

    expect(runJobCommand(database, claim)).toBe("claimed job-1 for record-a-factory-job on build-order");

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 1, active: 0, done: 0 });
    expect(snapshot.jobs[0]?.title).toBe("Record a factory job as work is taken");
    expect(snapshot.jobs[0]?.itemId).toBe("record-a-factory-job");
    expect(snapshot.jobs[0]?.status).toBe("waiting");
    expect(snapshot.jobs[0]?.station).toBe("build");
  });

  test("a claim keeps the item's description as the queue worded it", () => {
    const database = db();

    runJobCommand(database, claim);

    expect(database.query("SELECT description FROM factory_job WHERE id = 'job-1'").get()).toEqual({
      description: "The record holds what an item is called and never what it says.",
    });
  });

  test("a claim with no description records the job without one", () => {
    const database = db();
    const at = claim.indexOf("--description");

    runJobCommand(database, [...claim.slice(0, at), ...claim.slice(at + 2)]);

    expect(database.query("SELECT description FROM factory_job WHERE id = 'job-1'").get()).toEqual({
      description: null,
    });
  });

  test("a start moves that card into the active column", () => {
    const database = db();
    runJobCommand(database, claim);

    expect(runJobCommand(database, ["start", "job-1"])).toBe("job-1 is running");

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 1, done: 0 });
    expect(snapshot.jobs[0]?.status).toBe("running");
  });

  test("a move sends the card to the station the work is at now", () => {
    const database = db();
    runJobCommand(database, claim);
    runJobCommand(database, ["start", "job-1"]);

    expect(runJobCommand(database, ["move", "job-1", "--station", "dim-station-review"])).toBe(
      "job-1 moved to dim-station-review",
    );

    expect(assembleWallSnapshot(database).jobs[0]?.station).toBe("review");
  });

  test("a move with no station to move to is refused", () => {
    const database = db();
    runJobCommand(database, claim);
    runJobCommand(database, ["start", "job-1"]);

    expect(() => runJobCommand(database, ["move", "job-1"])).toThrow(JobCommandError);

    expect(assembleWallSnapshot(database).jobs[0]?.station).toBe("build");
  });

  test("a stop moves that card into the done column", () => {
    const database = db();
    runJobCommand(database, claim);
    runJobCommand(database, ["start", "job-1"]);
    landed(database, "job-1");

    expect(runJobCommand(database, ["stop", "job-1", "completed"])).toBe("job-1 stopped as completed");

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 0, done: 1 });
    expect(snapshot.jobs[0]?.status).toBe("completed");
  });

  test("a stop as completed is refused until a check has passed", () => {
    const database = db();
    runJobCommand(database, claim);
    runJobCommand(database, ["start", "job-1"]);
    runJobCommand(database, ["check", "job-1", "--command", "bun run verify", "--exit", "1"]);

    expect(() => runJobCommand(database, ["stop", "job-1", "completed"])).toThrow(
      expect.objectContaining({ code: "job_not_checked" }),
    );

    expect(assembleWallSnapshot(database).jobs[0]?.status).toBe("running");
    expect(runJobCommand(database, ["stop", "job-1", "blocked", "--reason", "waits on the wall"])).toBe(
      "job-1 stopped as blocked",
    );
  });

  test("a fence keeps the card active and shows why it stopped", () => {
    const database = db();
    runJobCommand(database, claim);
    runJobCommand(database, ["start", "job-1"]);

    runJobCommand(database, ["stop", "job-1", "fenced", "--reason", "outward-facing"]);

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 1, done: 0 });
    expect(snapshot.jobs[0]?.status).toBe("fenced");
    expect(snapshot.jobs[0]?.attention).toBe("outward-facing");
  });

  test("a running job records the evidence the work produced", () => {
    const database = db();
    runJobCommand(database, claim);
    runJobCommand(database, ["start", "job-1"]);

    expect(
      runJobCommand(database, ["commit", "job-1", "--sha", "abc123", "--subject", "feat: land it"]),
    ).toBe("job-1 recorded commit abc123");
    expect(runJobCommand(database, ["file", "job-1", "--path", "src/job-command.ts"])).toBe(
      "job-1 recorded src/job-command.ts",
    );
    expect(
      runJobCommand(database, [
        "check",
        "job-1",
        "--command",
        "bun run verify",
        "--exit",
        "0",
        "--result",
        "green",
      ]),
    ).toBe("job-1 recorded bun run verify (0)");
    expect(
      runJobCommand(database, [
        "finding",
        "job-1",
        "--dimension",
        "tests",
        "--summary",
        "the invariant holds",
        "--answer",
        "fixed",
      ]),
    ).toBe("job-1 recorded a fixed finding on tests");
    expect(runJobCommand(database, ["document", "job-1", "--path", "docs/factory.md"])).toBe(
      "job-1 recorded docs/factory.md",
    );

    expect(database.query("SELECT sha, subject FROM factory_job_commit").get()).toEqual({
      sha: "abc123",
      subject: "feat: land it",
    });
    expect(database.query("SELECT path FROM factory_job_file").get()).toEqual({
      path: "src/job-command.ts",
    });
    expect(database.query("SELECT command, exit_code, result FROM factory_job_check").get()).toEqual({
      command: "bun run verify",
      exit_code: 0,
      result: "green",
    });
    expect(database.query("SELECT dimension, summary, answer FROM factory_job_finding").get()).toEqual({
      dimension: "tests",
      summary: "the invariant holds",
      answer: "fixed",
    });
    expect(database.query("SELECT path FROM factory_job_document").get()).toEqual({
      path: "docs/factory.md",
    });
  });

  test("evidence is refused before the job started and after it stopped", () => {
    const database = db();
    runJobCommand(database, claim);

    expect(() => runJobCommand(database, ["commit", "job-1", "--sha", "abc123"])).toThrow(
      "job job-1 has not started",
    );

    runJobCommand(database, ["start", "job-1"]);
    landed(database, "job-1");
    runJobCommand(database, ["stop", "job-1", "completed"]);

    expect(() => runJobCommand(database, ["commit", "job-1", "--sha", "abc123"])).toThrow(
      "job job-1 is already completed",
    );
    expect(
      database.query("SELECT count(*) AS rows FROM factory_job_commit WHERE sha = 'abc123'").get(),
    ).toEqual({ rows: 0 });
  });

  test("a check with no exit status and a finding with no answer are refused", () => {
    const database = db();
    runJobCommand(database, claim);
    runJobCommand(database, ["start", "job-1"]);

    expect(() =>
      runJobCommand(database, ["check", "job-1", "--command", "bun run verify", "--exit", "green"]),
    ).toThrow(JobCommandError);
    expect(() =>
      runJobCommand(database, [
        "finding",
        "job-1",
        "--dimension",
        "tests",
        "--summary",
        "s",
        "--answer",
        "maybe",
      ]),
    ).toThrow(JobCommandError);
    for (const spec of ["", " ", "1e3"]) {
      expect(() =>
        runJobCommand(database, ["check", "job-1", "--command", "bun run verify", "--exit", spec]),
      ).toThrow(JobCommandError);
    }

    expect(database.query("SELECT count(*) AS rows FROM factory_job_check").get()).toEqual({ rows: 0 });
    expect(database.query("SELECT count(*) AS rows FROM factory_job_finding").get()).toEqual({ rows: 0 });
  });

  test("a refused finding is not recorded without the grounds it rests on", () => {
    const database = db();
    runJobCommand(database, claim);
    runJobCommand(database, ["start", "job-1"]);

    expect(() =>
      runJobCommand(database, [
        "finding",
        "job-1",
        "--dimension",
        "docs",
        "--summary",
        "a doc did not move",
        "--answer",
        "refused",
      ]),
    ).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_CHECK" }));

    expect(database.query("SELECT count(*) AS rows FROM factory_job_finding").get()).toEqual({ rows: 0 });
  });

  test("a status a job cannot stop at is refused rather than written", () => {
    const database = db();
    runJobCommand(database, claim);
    runJobCommand(database, ["start", "job-1"]);

    expect(() => runJobCommand(database, ["stop", "job-1", "running"])).toThrow(JobCommandError);

    expect(assembleWallSnapshot(database).jobs[0]?.status).toBe("running");
    landed(database, "job-1");
    expect(runJobCommand(database, ["stop", "job-1", "completed"])).toBe("job-1 stopped as completed");
  });

  test("a claim missing identity is refused before any row is written", () => {
    const database = db();

    expect(() => runJobCommand(database, ["claim", "job-1", "--run", "run-1"])).toThrow(JobCommandError);
    expect(assembleWallSnapshot(database).jobs).toEqual([]);
  });

  test("an unknown subcommand, an unknown flag and a repeated flag are refused", () => {
    const database = db();

    expect(() => runJobCommand(database, ["park", "job-1"])).toThrow(JobCommandError);
    expect(() => runJobCommand(database, ["toString", "job-1"])).toThrow(JobCommandError);
    expect(() => runJobCommand(database, [...claim, "--colour", "red"])).toThrow(JobCommandError);
    expect(() => runJobCommand(database, [...claim, "--title", "second"])).toThrow(JobCommandError);
  });
});
