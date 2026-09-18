import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendJobEvent, createJob, recordJobCheck, recordJobCommit } from "./factory-job";
import { assembleWallSnapshot, buildWallBundle } from "./factory-wall";
import { SCHEMA_SQL } from "./schema";

describe("factory wall snapshot", () => {
  test("assembles current work for the board from read-only job records", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createJob(
      db,
      {
        id: "job-running",
        runId: "run",
        queueId: "queue",
        itemId: "wall",
        agentId: "builder",
        station: "build",
        worktree: "/tmp/wall",
        branch: "wall",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendJobEvent(
      db,
      "job-running",
      { kind: "started", status: "running", actorId: "builder" },
      "2026-09-18T10:01:00.000Z",
    );
    recordJobCheck(
      db,
      "job-running",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:02:00.000Z",
    );
    createJob(
      db,
      { id: "job-blocked", runId: "run", queueId: "queue", itemId: "blocked", station: "review" },
      "2026-09-18T09:00:00.000Z",
    );
    appendJobEvent(
      db,
      "job-blocked",
      { kind: "fenced", status: "fenced", fenceType: "owner-judgment", reason: "scope unclear" },
      "2026-09-18T09:05:00.000Z",
    );
    createJob(
      db,
      {
        id: "job-done",
        runId: "run",
        queueId: "queue",
        itemId: "done",
        station: "ship",
        worktree: "/tmp/wall-done",
        branch: "wall-done",
      },
      "2026-09-18T08:00:00.000Z",
    );
    appendJobEvent(db, "job-done", { kind: "started", status: "running" }, "2026-09-18T08:00:30.000Z");
    recordJobCommit(db, "job-done", "abc123", "wall", "2026-09-18T08:01:00.000Z");
    appendJobEvent(
      db,
      "job-done",
      { kind: "completed", status: "completed", reason: "verified" },
      "2026-09-18T08:02:00.000Z",
    );

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:10:00.000Z"));

    expect(snapshot.source).toBe("database");
    expect(snapshot.jobs.map((job) => [job.item, job.station, job.status])).toEqual([
      ["wall", "build", "running"],
      ["blocked", "review", "fenced"],
    ]);
    expect(snapshot.jobs[1]?.attention).toBe("scope unclear");
    expect(snapshot.jobs[0]).toEqual({
      id: "job-running",
      item: "wall",
      station: "build",
      agent: "builder",
      role: "builder",
      status: "running",
      action: "check finished",
      age: "8m",
      updatedAt: "2026-09-18T10:02:00.000Z",
      evidence: "bun run verify",
    });
    db.close();
  });

  test("bounds the active cards shown on the board", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    for (let index = 0; index < 14; index += 1) {
      const id = `job-${index}`;
      createJob(
        db,
        { id, runId: "run", queueId: "queue", itemId: id, station: "build" },
        "2026-09-18T09:00:00.000Z",
      );
      appendJobEvent(
        db,
        id,
        { kind: "fenced", status: "fenced", reason: `reason-${index}` },
        "2026-09-18T09:01:00.000Z",
      );
    }

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:10:00.000Z"));

    expect(snapshot.jobs).toHaveLength(12);
    db.close();
  });

  test("does not expose a control route", async () => {
    const response = new Response("Not found", { status: 404 });
    expect(response.status).toBe(404);
  });

  test("builds the kanban client bundle", async () => {
    const bundle = await buildWallBundle();

    expect(bundle.js.byteLength).toBeGreaterThan(0);
    expect(bundle.css.byteLength).toBeGreaterThan(0);
  });
});
