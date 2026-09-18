import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { assembleWallSnapshot } from "./factory-wall";
import { JobCommandError, runJobCommand } from "./job-command";
import { SCHEMA_SQL } from "./schema";

function db(): Database {
  const database = new Database(":memory:");
  database.run(SCHEMA_SQL);
  return database;
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
  "--agent",
  "agent-1",
  "--station",
  "dim-station-build",
  "--worktree",
  "/tmp/wt",
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

  test("a start moves that card into the active column", () => {
    const database = db();
    runJobCommand(database, claim);

    expect(runJobCommand(database, ["start", "job-1"])).toBe("job-1 is running");

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 1, done: 0 });
    expect(snapshot.jobs[0]?.status).toBe("running");
  });

  test("a stop moves that card into the done column", () => {
    const database = db();
    runJobCommand(database, claim);
    runJobCommand(database, ["start", "job-1"]);

    expect(runJobCommand(database, ["stop", "job-1", "completed"])).toBe("job-1 stopped as completed");

    const snapshot = assembleWallSnapshot(database);
    expect(snapshot.totals).toEqual({ todo: 0, active: 0, done: 1 });
    expect(snapshot.jobs[0]?.status).toBe("completed");
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

  test("a status a job cannot stop at is refused rather than written", () => {
    const database = db();
    runJobCommand(database, claim);
    runJobCommand(database, ["start", "job-1"]);

    expect(() => runJobCommand(database, ["stop", "job-1", "running"])).toThrow(JobCommandError);

    expect(assembleWallSnapshot(database).jobs[0]?.status).toBe("running");
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
    expect(() => runJobCommand(database, [...claim, "--colour", "red"])).toThrow(JobCommandError);
    expect(() => runJobCommand(database, [...claim, "--title", "second"])).toThrow(JobCommandError);
  });
});
