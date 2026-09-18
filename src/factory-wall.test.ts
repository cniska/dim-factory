import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appendJobEvent, createJob, recordJobCheck, recordJobCommit } from "./factory-job";
import { assembleWallSnapshot, serveWall } from "./factory-wall";
import { SCHEMA_SQL } from "./schema";
import { workerName } from "./worker-name";

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
    expect(snapshot.jobs.map((job) => [job.item, job.station, job.status, job.lifecycle])).toEqual([
      ["wall", "build", "running", "active"],
      ["blocked", "review", "fenced", "active"],
      ["done", "ship", "completed", "done"],
    ]);
    expect(snapshot.jobs[1]?.attention).toBe("scope unclear");
    expect(snapshot.jobs[0]).toEqual({
      id: "job-running",
      item: "wall",
      station: "build",
      lifecycle: "active",
      agent: "builder",
      worker: workerName("builder"),
      role: "builder",
      status: "running",
      action: "Repository check finished",
      age: "8m",
      updatedAt: "2026-09-18T10:02:00.000Z",
      evidence: "bun run verify",
    });
    db.close();
  });

  test("puts a claimed job that has not started in the todo column", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createJob(
      db,
      { id: "job-claimed", runId: "run", queueId: "queue", itemId: "waiting", station: "plan" },
      "2026-09-18T10:00:00.000Z",
    );

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z"));

    expect(snapshot.jobs.map((job) => [job.status, job.lifecycle])).toEqual([["waiting", "todo"]]);
    db.close();
  });

  test("puts an abandoned job in the done column with its stop reason", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createJob(
      db,
      { id: "job-gone", runId: "run", queueId: "queue", itemId: "gone", station: "build" },
      "2026-09-18T10:00:00.000Z",
    );
    appendJobEvent(db, "job-gone", { kind: "started", status: "running" }, "2026-09-18T10:01:00.000Z");
    appendJobEvent(
      db,
      "job-gone",
      { kind: "abandoned", status: "abandoned", reason: "operator stopped" },
      "2026-09-18T10:02:00.000Z",
    );

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z"));

    expect(snapshot.jobs.map((job) => [job.status, job.lifecycle, job.attention])).toEqual([
      ["abandoned", "done", "operator stopped"],
    ]);
    db.close();
  });

  test("bounds each lifecycle column so finished work cannot crowd out current work", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const seed = (id: string, kind: "fenced" | "completed") => {
      createJob(
        db,
        {
          id,
          runId: "run",
          queueId: "queue",
          itemId: id,
          station: "build",
          worktree: `/tmp/${id}`,
          branch: id,
        },
        "2026-09-18T09:00:00.000Z",
      );
      if (kind === "completed")
        appendJobEvent(db, id, { kind: "started", status: "running" }, "2026-09-18T09:00:30.000Z");
      appendJobEvent(db, id, { kind, status: kind, reason: `reason-${id}` }, "2026-09-18T09:01:00.000Z");
    };
    for (let index = 0; index < 14; index += 1) seed(`fenced-${index}`, "fenced");
    for (let index = 0; index < 14; index += 1) seed(`done-${index}`, "completed");

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:10:00.000Z"));

    expect(snapshot.jobs.filter((job) => job.lifecycle === "active")).toHaveLength(12);
    expect(snapshot.jobs.filter((job) => job.lifecycle === "done")).toHaveLength(12);
    expect(snapshot.totals).toEqual({ todo: 0, active: 14, done: 14 });
    db.close();
  });

  test("serves snapshots, has no control route and refuses client messages", async () => {
    const file = `${tmpdir()}/wall-${Date.now()}.sqlite`;
    const seed = new Database(file);
    seed.run(SCHEMA_SQL);
    seed.close();
    const server = await serveWall({ port: 0, databasePath: file });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const snapshot = await fetch(`${origin}/api/snapshot`);
      expect(snapshot.status).toBe(200);
      expect((await snapshot.json()).source).toBe("database");

      const control = await fetch(`${origin}/api/control`, { method: "POST", body: "{}" });
      expect(control.status).toBe(404);

      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const rejection = await Promise.race([
        new Promise<string>((resolve, reject) => {
          socket.onopen = () => socket.send(JSON.stringify({ command: "cancel" }));
          socket.onmessage = (event) => resolve(String(event.data));
          socket.onerror = () => reject(new Error("socket failed"));
        }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("client message was not answered")), 2000),
        ),
      ]);
      socket.close();
      expect(JSON.parse(rejection)).toEqual({ error: "read-only wall" });
    } finally {
      server.stop(true);
      rmSync(file, { force: true });
    }
  });

  test("serves a page whose script and stylesheet load", async () => {
    const server = await serveWall({ port: 0 });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const page = await fetch(origin);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('id="root"');

      const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1] ?? "");
      const script = assets.find((asset) => asset.endsWith(".js"));
      const style = assets.find((asset) => asset.endsWith(".css"));
      expect(script).toBeDefined();
      expect(style).toBeDefined();

      const bundled = await fetch(`${origin}${script}`);
      expect(bundled.status).toBe(200);
      expect((await bundled.text()).length).toBeGreaterThan(0);

      const stylesheet = await fetch(`${origin}${style}`);
      expect(stylesheet.status).toBe(200);
      // Tailwind ran: a utility the board uses is in the sheet the page links.
      expect(await stylesheet.text()).toContain("grid-cols-3");

      const font = await fetch(`${origin}/wall.woff2`);
      expect(font.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });
});
