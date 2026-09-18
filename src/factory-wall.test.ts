import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  appendJobEvent,
  createJob,
  recordJobCheck,
  recordJobCommit,
  recordJobDocument,
  recordJobEnvironment,
  recordJobFile,
  recordJobFinding,
} from "./factory-job";
import { assembleItemView, assembleWallSnapshot, serveWall } from "./factory-wall";
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
        title: "Show the wall",
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
      {
        id: "job-blocked",
        runId: "run",
        queueId: "queue",
        itemId: "blocked",
        title: "Unblock the queue",
        station: "review",
      },
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
        title: "Ship the board",
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
    expect(snapshot.jobs.map((job) => [job.title, job.station, job.status, job.lifecycle])).toEqual([
      ["Show the wall", "build", "running", "active"],
      ["Unblock the queue", "review", "fenced", "active"],
      ["Ship the board", "ship", "completed", "done"],
    ]);
    expect(snapshot.jobs.map((job) => job.itemId)).toEqual(["wall", "blocked", "done"]);
    expect(snapshot.jobs[1]?.attention).toBe("scope unclear");
    expect(snapshot.jobs[0]).toEqual({
      id: "job-running",
      title: "Show the wall",
      itemId: "wall",
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
      {
        id: "job-claimed",
        runId: "run",
        queueId: "queue",
        itemId: "waiting",
        title: "Wait for a builder",
        station: "plan",
      },
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
      {
        id: "job-gone",
        runId: "run",
        queueId: "queue",
        itemId: "gone",
        title: "Abandon this one",
        station: "build",
      },
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
          title: `Crowd the column as ${id}`,
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

describe("factory wall item view", () => {
  const seedWorkedJob = (db: Database): void => {
    createJob(
      db,
      {
        id: "job-worked",
        runId: "run",
        queueId: "queue",
        itemId: "worked",
        title: "Work an item through",
        agentId: "builder",
        station: "build",
        worktree: "/tmp/worked",
        branch: "worked",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendJobEvent(
      db,
      "job-worked",
      { kind: "started", status: "running", actorId: "builder" },
      "2026-09-18T10:01:00.000Z",
    );
    recordJobEnvironment(
      db,
      "job-worked",
      {
        phase: "setup",
        argv: ["/tmp/worked/scripts/worktree-setup.sh"],
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "the port was already held",
        resources: [{ port: 5433 }],
      },
      "2026-09-18T10:02:00.000Z",
    );
    recordJobCheck(
      db,
      "job-worked",
      { command: "bun run verify", exitCode: 1, result: "typecheck failed" },
      "2026-09-18T10:03:00.000Z",
    );
    recordJobCheck(
      db,
      "job-worked",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:04:00.000Z",
    );
    recordJobFile(db, "job-worked", "src/factory-wall.ts", "2026-09-18T10:05:00.000Z");
    recordJobCommit(db, "job-worked", "abc123", "feat: read one job's record", "2026-09-18T10:06:00.000Z");
    recordJobFinding(
      db,
      "job-worked",
      { dimension: "tests", summary: "the rail has no test", answer: "fixed" },
      "2026-09-18T10:07:00.000Z",
    );
    recordJobFinding(
      db,
      "job-worked",
      {
        dimension: "style",
        summary: "the dialog should use a component library",
        answer: "refused",
        resolution: "the design doc rules a library out for this surface",
      },
      "2026-09-18T10:08:00.000Z",
    );
    recordJobDocument(db, "job-worked", "docs/human-interface.md", "2026-09-18T10:09:00.000Z");
    appendJobEvent(
      db,
      "job-worked",
      { kind: "completed", status: "completed", reason: "verified" },
      "2026-09-18T10:10:00.000Z",
    );
  };

  test("reads one job's lifecycle in the order it was written", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    seedWorkedJob(db);

    const view = assembleItemView(db, "job-worked", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.entries.map((entry) => entry.kind)).toEqual([
      "claimed",
      "started",
      "environment_reported",
      "check_finished",
      "check_finished",
      "file_changed",
      "commit_created",
      "review_finished",
      "review_finished",
      "document_updated",
      "completed",
    ]);
    db.close();
  });

  test("carries the job's identity above what is being read", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    seedWorkedJob(db);

    const view = assembleItemView(db, "job-worked", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.job.title).toBe("Work an item through");
    expect(view?.job.station).toBe("build");
    expect(view?.job.status).toBe("completed");
    expect(view?.job.worker).toBe(workerName("builder"));
    expect([view?.runId, view?.queueId, view?.job.itemId]).toEqual(["run", "queue", "worked"]);
    expect([view?.worktree, view?.branch]).toEqual(["/tmp/worked", "worked"]);
    db.close();
  });

  test("attaches each commit, check and finding to the event that produced it", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    seedWorkedJob(db);

    const entries = assembleItemView(db, "job-worked", new Date("2026-09-18T10:20:00.000Z"))?.entries ?? [];

    expect(entries.find((entry) => entry.kind === "commit_created")?.commit).toEqual({
      sha: "abc123",
      subject: "feat: read one job's record",
    });
    expect(entries.filter((entry) => entry.kind === "check_finished").map((entry) => entry.check)).toEqual([
      { command: "bun run verify", exitCode: 1, result: "typecheck failed" },
      { command: "bun run verify", exitCode: 0, result: "green" },
    ]);
    expect(entries.filter((entry) => entry.kind === "review_finished").map((entry) => entry.finding)).toEqual(
      [
        { dimension: "tests", answer: "fixed", summary: "the rail has no test" },
        {
          dimension: "style",
          answer: "refused",
          summary: "the dialog should use a component library",
          resolution: "the design doc rules a library out for this surface",
        },
      ],
    );
    expect(entries.find((entry) => entry.kind === "file_changed")?.path).toBe("src/factory-wall.ts");
    expect(entries.find((entry) => entry.kind === "document_updated")?.path).toBe("docs/human-interface.md");
    expect(entries.find((entry) => entry.kind === "environment_reported")?.environment).toEqual({
      phase: "setup",
      argv: ["/tmp/worked/scripts/worktree-setup.sh"],
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "the port was already held",
      resources: [{ port: 5433 }],
    });
    db.close();
  });

  test("names the worker a delegation handed to", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createJob(
      db,
      {
        id: "job-delegating",
        runId: "run",
        queueId: "queue",
        itemId: "delegating",
        title: "Hand work to a reviewer",
        agentId: "builder",
        station: "build",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendJobEvent(db, "job-delegating", { kind: "started", status: "running" }, "2026-09-18T10:01:00.000Z");
    appendJobEvent(
      db,
      "job-delegating",
      { kind: "delegated", actorId: "builder", delegatedAgentId: "reviewer", delegatedStation: "review" },
      "2026-09-18T10:02:00.000Z",
    );

    const view = assembleItemView(db, "job-delegating", new Date("2026-09-18T10:20:00.000Z"));
    const delegation = view?.entries.find((entry) => entry.kind === "delegated");

    expect(delegation?.worker).toBe(workerName("builder"));
    expect(delegation?.delegatedTo).toEqual({
      agent: "reviewer",
      worker: workerName("reviewer"),
      station: "review",
    });
    db.close();
  });

  test("keeps the grounds a fence stopped on", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createJob(
      db,
      {
        id: "job-fenced",
        runId: "run",
        queueId: "queue",
        itemId: "fenced",
        title: "Stop at a fence",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendJobEvent(
      db,
      "job-fenced",
      { kind: "fenced", status: "fenced", fenceType: "owner-judgment", reason: "scope unclear" },
      "2026-09-18T10:01:00.000Z",
    );

    const view = assembleItemView(db, "job-fenced", new Date("2026-09-18T10:20:00.000Z"));
    const fence = view?.entries.find((entry) => entry.kind === "fenced");

    expect([fence?.fence, fence?.reason]).toEqual(["owner-judgment", "scope unclear"]);
    db.close();
  });

  test("has nothing to show for a job it holds no record of", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);

    expect(assembleItemView(db, "job-absent", new Date("2026-09-18T10:20:00.000Z"))).toBeNull();
    db.close();
  });

  test("reads only the job asked for, where another job's evidence shares its ids", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    seedWorkedJob(db);
    createJob(
      db,
      {
        id: "job-other",
        runId: "run",
        queueId: "queue",
        itemId: "other",
        title: "Work a second item",
        worktree: "/tmp/other",
        branch: "other",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendJobEvent(db, "job-other", { kind: "started", status: "running" }, "2026-09-18T10:01:00.000Z");
    recordJobCheck(
      db,
      "job-other",
      { command: "bun run other", exitCode: 0, result: "green" },
      "2026-09-18T10:03:00.000Z",
    );
    recordJobFile(db, "job-other", "src/other.ts", "2026-09-18T10:05:00.000Z");
    recordJobDocument(db, "job-other", "docs/other.md", "2026-09-18T10:09:00.000Z");

    const entries = assembleItemView(db, "job-other", new Date("2026-09-18T10:20:00.000Z"))?.entries ?? [];

    expect(entries.map((entry) => entry.kind)).toEqual([
      "claimed",
      "started",
      "check_finished",
      "file_changed",
      "document_updated",
    ]);
    expect(entries.map((entry) => entry.check?.command).filter(Boolean)).toEqual(["bun run other"]);
    expect(entries.map((entry) => entry.path).filter(Boolean)).toEqual(["src/other.ts", "docs/other.md"]);
    db.close();
  });

  test("serves one job's record and holds a job id it cannot read to 404", async () => {
    const file = `${tmpdir()}/wall-item-${Date.now()}.sqlite`;
    const seed = new Database(file);
    seed.run(SCHEMA_SQL);
    seedWorkedJob(seed);
    seed.close();
    const server = await serveWall({ port: 0, databasePath: file });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const found = await fetch(`${origin}/api/job/job-worked`);
      expect(found.status).toBe(200);
      const view = await found.json();
      expect(view.job.title).toBe("Work an item through");
      expect(view.entries.at(-1)).toEqual({
        at: "2026-09-18T10:10:00.000Z",
        kind: "completed",
        reason: "verified",
      });

      expect((await fetch(`${origin}/api/job/job-absent`)).status).toBe(404);
      expect((await fetch(`${origin}/api/job/`)).status).toBe(404);
      // A percent sequence that is not valid UTF-8 is an id, not a crash.
      expect((await fetch(`${origin}/api/job/%E0%A4%A`)).status).toBe(404);
    } finally {
      server.stop(true);
      rmSync(file, { force: true });
    }
  });

  test("says the database is unavailable rather than serving an empty record", async () => {
    const server = await serveWall({ port: 0, databasePath: `${tmpdir()}/wall-absent-${Date.now()}.sqlite` });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const item = await fetch(`${origin}/api/job/job-worked`);
      expect(item.status).toBe(503);
      expect((await item.json()).error).toContain("no database at");

      const snapshot = await fetch(`${origin}/api/snapshot`);
      expect(snapshot.status).toBe(503);
      expect((await snapshot.json()).error).toContain("no database at");
    } finally {
      server.stop(true);
    }
  });
});
