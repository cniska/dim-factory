import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendJobEvent, createJob, recordJobCheck, recordJobCommit } from "./factory-job";
import { assembleWallSnapshot } from "./factory-wall";
import { parseQueue } from "./queue-planner";
import { SCHEMA_SQL } from "./schema";

describe("factory wall snapshot", () => {
  test("assembles current work and attention from the read-only job records", () => {
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
      { id: "job-done", runId: "run", queueId: "queue", itemId: "done", station: "landing" },
      "2026-09-18T08:00:00.000Z",
    );
    recordJobCommit(db, "job-done", "abc123", "wall", "2026-09-18T08:01:00.000Z");
    appendJobEvent(
      db,
      "job-done",
      { kind: "completed", status: "completed", reason: "verified" },
      "2026-09-18T08:02:00.000Z",
    );

    const queue = parseQueue(
      JSON.stringify({
        version: 1,
        id: "queue",
        items: [
          { id: "ready", title: "Ready item", dependencies: [], status: "planned", transitions: [] },
          {
            id: "waiting",
            title: "Waiting item",
            dependencies: ["ready"],
            status: "planned",
            transitions: [],
          },
        ],
      }),
    );
    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:10:00.000Z"), queue);

    expect(snapshot.source).toBe("database");
    expect(snapshot.jobs.map((job) => [job.item, job.station, job.status])).toEqual([
      ["wall", "build", "running"],
      ["blocked", "review", "fenced"],
    ]);
    expect(snapshot.jobs[1]?.attention).toBe("scope unclear");
    expect(snapshot.finished[0]?.item).toBe("done");
    expect(snapshot.next).toEqual(["ready: Ready item"]);
    expect(snapshot.nextTotal).toBe(1);
    expect(snapshot.jobs[0]?.next).toBe("No next action recorded");
    expect(snapshot.stationTotals).toEqual({ plan: 0, build: 1, review: 1, landing: 0 });
    db.close();
  });

  test("bounds active and attention rows while preserving totals", () => {
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

    const snapshot = assembleWallSnapshot(
      db,
      new Date("2026-09-18T10:10:00.000Z"),
      parseQueue('{"version":1,"id":"queue","items":[]}'),
    );

    expect(snapshot.jobs).toHaveLength(12);
    expect(snapshot.activeTotal).toBe(14);
    expect(snapshot.attention).toHaveLength(8);
    expect(snapshot.attentionTotal).toBe(14);
    expect(snapshot.stationTotals.build).toBe(14);
    db.close();
  });

  test("states queue eligibility as unavailable without a queue source", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:10:00.000Z"));

    expect(snapshot.next).toEqual(["Queue eligibility unavailable"]);
    expect(snapshot.nextTotal).toBeNull();
    db.close();
  });

  test("does not expose a control route", async () => {
    const response = new Response("Not found", { status: 404 });
    expect(response.status).toBe(404);
  });
});
