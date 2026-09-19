import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  appendOrderEvent,
  createOrder,
  type OrderRole,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderEnvironment,
  recordOrderFile,
  recordOrderFinding,
  updateOrderLocation,
} from "./factory-order";
import { assembleItemView, assembleWallSnapshot, serveWall } from "./factory-wall";
import { integratedRepo } from "./fixtures.test-support";
import { resolveHomeDir } from "./paths";
import { SCHEMA_SQL } from "./schema";
import { STATION_LABELS } from "./wall-board";
import { workerName } from "./worker-name";

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

describe("factory wall snapshot", () => {
  test("assembles current work for the board from read-only order records", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(
      db,
      {
        id: "order-running",
        runId: "run",
        queueId: "queue",
        itemId: "wall",
        title: "Show the wall",
        agentId: "builder",
        role: "builder",
        station: "build",
        worktree: "/tmp/wall",
        branch: "wall",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendOrderEvent(
      db,
      "order-running",
      { kind: "started", status: "working", actorId: "builder" },
      "2026-09-18T10:01:00.000Z",
    );
    recordOrderCheck(
      db,
      "order-running",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:02:00.000Z",
    );
    createOrder(
      db,
      {
        id: "order-blocked",
        runId: "run",
        queueId: "queue",
        itemId: "blocked",
        title: "Unblock the queue",
        station: "review",
      },
      "2026-09-18T09:00:00.000Z",
    );
    appendOrderEvent(
      db,
      "order-blocked",
      { kind: "fenced", status: "fenced", fenceType: "owner-judgment", reason: "scope unclear" },
      "2026-09-18T09:05:00.000Z",
    );
    createOrder(
      db,
      {
        id: "order-done",
        runId: "run",
        queueId: "queue",
        itemId: "done",
        title: "Ship the board",
        station: "ship",
        worktree: trunk.dir,
        branch: "wall-done",
      },
      "2026-09-18T08:00:00.000Z",
    );
    appendOrderEvent(db, "order-done", { kind: "started", status: "working" }, "2026-09-18T08:00:30.000Z");
    recordOrderCommit(db, "order-done", trunk.sha, "wall", "2026-09-18T08:01:00.000Z");
    recordOrderCheck(
      db,
      "order-done",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T08:01:30.000Z",
    );
    appendOrderEvent(
      db,
      "order-done",
      { kind: "completed", status: "completed", reason: "verified" },
      "2026-09-18T08:02:00.000Z",
    );

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:10:00.000Z"));

    expect(snapshot.source).toBe("database");
    expect(snapshot.orders.map((order) => [order.title, order.station, order.status, order.stage])).toEqual([
      ["Unblock the queue", "review", "fenced", "active"],
      ["Show the wall", "build", "working", "active"],
      ["Ship the board", "ship", "completed", "done"],
    ]);
    expect(snapshot.orders.map((order) => order.itemId)).toEqual(["blocked", "wall", "done"]);
    expect(snapshot.orders[0]?.attention).toBe("scope unclear");
    expect(snapshot.orders[1]).toEqual({
      id: "order-running",
      title: "Show the wall",
      itemId: "wall",
      station: "build",
      stage: "active",
      agent: "builder",
      worker: workerName("builder"),
      role: "builder",
      status: "working",
      age: "8m",
      lastEventAt: "2026-09-18T10:02:00.000Z",
      failedChecks: 0,
    });
    db.close();
  });

  test("puts a claimed order that has not started in the todo column", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(
      db,
      {
        id: "order-claimed",
        runId: "run",
        queueId: "queue",
        itemId: "waiting",
        title: "Wait for a builder",
        station: "plan",
      },
      "2026-09-18T10:00:00.000Z",
    );

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z"));

    expect(snapshot.orders.map((order) => [order.status, order.stage])).toEqual([["waiting", "todo"]]);
    db.close();
  });

  test("puts a failed order in the done column with its stop reason", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(
      db,
      {
        id: "order-gone",
        runId: "run",
        queueId: "queue",
        itemId: "gone",
        title: "Stop this one",
        station: "build",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendOrderEvent(db, "order-gone", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    appendOrderEvent(
      db,
      "order-gone",
      { kind: "failed", status: "failed", reason: "operator stopped" },
      "2026-09-18T10:02:00.000Z",
    );

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z"));

    expect(snapshot.orders.map((order) => [order.status, order.stage, order.attention])).toEqual([
      ["failed", "done", "operator stopped"],
    ]);
    db.close();
  });

  test("has an event to age every claimed order from", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(
      db,
      { id: "order-fresh", runId: "run", queueId: "queue", itemId: "fresh", title: "Only just claimed" },
      "2026-09-18T10:00:00.000Z",
    );

    // The board reads its one figure off the last event, which holds because a claim writes an
    // event in the same transaction as the order row.
    expect(db.query("SELECT count(*) AS events FROM factory_order_event").get()).toEqual({ events: 1 });
    expect(assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z")).orders[0]?.age).toBe("5m");
    db.close();
  });

  test("ages an order from its last recorded event, not from the row's last write", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(
      db,
      {
        id: "order-quiet",
        runId: "run",
        queueId: "queue",
        itemId: "quiet",
        title: "Go quiet after starting",
        station: "build",
      },
      "2026-09-18T09:00:00.000Z",
    );
    appendOrderEvent(db, "order-quiet", { kind: "started", status: "working" }, "2026-09-18T09:05:00.000Z");
    // Writes the order row without recording an event, which is how an order's row can be newer
    // than anything that happened to it.
    updateOrderLocation(db, "order-quiet", "/tmp/quiet", "quiet");
    db.run("UPDATE factory_order SET updated_at = ? WHERE id = ?", [
      "2026-09-18T10:04:00.000Z",
      "order-quiet",
    ]);

    const order = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z")).orders[0];

    expect(order?.lastEventAt).toBe("2026-09-18T09:05:00.000Z");
    expect(order?.age).toBe("1h 0m");
    db.close();
  });

  test("counts the checks a running order failed and leaves a passing one silent", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(
      db,
      {
        id: "order-struggling",
        runId: "run",
        queueId: "queue",
        itemId: "struggling",
        title: "Fail the check twice",
        station: "build",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendOrderEvent(
      db,
      "order-struggling",
      { kind: "started", status: "working" },
      "2026-09-18T10:01:00.000Z",
    );
    recordOrderCheck(
      db,
      "order-struggling",
      { command: "bun run verify", exitCode: 1, result: "lint failed" },
      "2026-09-18T10:02:00.000Z",
    );
    recordOrderCheck(
      db,
      "order-struggling",
      { command: "bun run verify", exitCode: 2, result: "typecheck failed" },
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderCheck(
      db,
      "order-struggling",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:04:00.000Z",
    );

    createOrder(
      db,
      {
        id: "order-clean",
        runId: "run",
        queueId: "queue",
        itemId: "clean",
        title: "Pass the check first time",
        station: "build",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendOrderEvent(db, "order-clean", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderCheck(
      db,
      "order-clean",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:02:00.000Z",
    );

    const failures = new Map(
      assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z")).orders.map((order) => [
        order.itemId,
        order.failedChecks,
      ]),
    );

    expect(failures.get("struggling")).toBe(2);
    expect(failures.get("clean")).toBe(0);
    db.close();
  });

  test("names no worker for an order no claim and no event named an agent for", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(
      db,
      {
        id: "order-unattributed",
        runId: "run",
        queueId: "queue",
        itemId: "unattributed",
        title: "Claimed by nobody in particular",
        station: "dim-station-build",
      },
      "2026-09-18T10:00:00.000Z",
    );

    const order = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z")).orders[0];

    expect(order).toEqual({
      id: "order-unattributed",
      title: "Claimed by nobody in particular",
      itemId: "unattributed",
      station: "build",
      stage: "todo",
      // Nobody was named, so nothing says what kind of worker this is either.
      role: "unknown",
      status: "waiting",
      age: "5m",
      lastEventAt: "2026-09-18T10:00:00.000Z",
      failedChecks: 0,
    });
    db.close();
  });

  test("reads a role off the claim, never off the station or the agent's name", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const claim = (id: string, recorded: OrderRole | undefined, stationValue: string, agentId: string) =>
      createOrder(
        db,
        {
          id,
          runId: "run",
          queueId: "queue",
          itemId: id,
          title: `Claim ${id}`,
          agentId,
          station: stationValue,
          ...(recorded ? { role: recorded } : {}),
        },
        "2026-09-18T10:00:00.000Z",
      );
    // A builder sitting at the review station is still a builder, and a name that reads
    // like a role is a string somebody typed.
    claim("planning", "planner", "dim-station-build", "agent-1");
    claim("building", "builder", "dim-station-review", "planner-2");
    claim("reviewing", "reviewer", "dim-station-plan", "agent-3");
    claim("unrecorded", undefined, "dim-station-build", "builder-4");

    const roles = new Map(
      assembleWallSnapshot(db, new Date("2026-09-18T10:20:00.000Z")).orders.map((order) => [
        order.itemId,
        order.role,
      ]),
    );

    expect(roles.get("planning")).toBe("planner");
    expect(roles.get("building")).toBe("builder");
    expect(roles.get("reviewing")).toBe("reviewer");
    expect(roles.get("unrecorded")).toBe("unknown");
    db.close();
  });

  test("says a station it does not know is unknown rather than calling it build", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(
      db,
      {
        id: "order-line",
        runId: "run",
        queueId: "queue",
        itemId: "line",
        title: "Claimed with a line, not a station",
        station: "dim-line-feat",
      },
      "2026-09-18T10:00:00.000Z",
    );
    createOrder(
      db,
      {
        id: "order-stationless",
        runId: "run",
        queueId: "queue",
        itemId: "stationless",
        title: "Claimed with no station at all",
      },
      "2026-09-18T09:00:00.000Z",
    );

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z"));

    expect(snapshot.orders.map((order) => order.station)).toEqual(["unknown", "unknown"]);
    expect(STATION_LABELS.unknown).toBe("Unknown");
    db.close();
  });

  test("bounds each stage column so finished work cannot crowd out current work", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const seed = (id: string, kind: "fenced" | "completed") => {
      createOrder(
        db,
        {
          id,
          runId: "run",
          queueId: "queue",
          itemId: id,
          title: `Crowd the column as ${id}`,
          station: "build",
          worktree: trunk.dir,
          branch: id,
        },
        "2026-09-18T09:00:00.000Z",
      );
      if (kind === "completed") {
        appendOrderEvent(db, id, { kind: "started", status: "working" }, "2026-09-18T09:00:30.000Z");
        recordOrderCommit(db, id, trunk.sha, "feat: land it", "2026-09-18T09:00:40.000Z");
        recordOrderCheck(
          db,
          id,
          { command: "bun run verify", exitCode: 0, result: "green" },
          "2026-09-18T09:00:45.000Z",
        );
      }
      appendOrderEvent(db, id, { kind, status: kind, reason: `reason-${id}` }, "2026-09-18T09:01:00.000Z");
    };
    for (let index = 0; index < 14; index += 1) seed(`fenced-${index}`, "fenced");
    for (let index = 0; index < 14; index += 1) seed(`done-${index}`, "completed");

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:10:00.000Z"));

    expect(snapshot.orders.filter((order) => order.stage === "active")).toHaveLength(12);
    expect(snapshot.orders.filter((order) => order.stage === "done")).toHaveLength(12);
    expect(snapshot.totals).toEqual({ todo: 0, active: 14, done: 14 });
    db.close();
  });

  test("keeps an order that needs a person on the board and at the top of its column", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(
      db,
      {
        id: "order-fenced-early",
        runId: "run",
        queueId: "queue",
        itemId: "fenced-early",
        title: "Stop and wait for the owner",
        station: "build",
      },
      "2026-09-18T08:00:00.000Z",
    );
    appendOrderEvent(
      db,
      "order-fenced-early",
      { kind: "fenced", status: "fenced", reason: "scope unclear" },
      "2026-09-18T08:02:00.000Z",
    );
    // More running work than a column draws, every piece of it newer than the fenced order, which
    // is what a bound applied before the ranking would drop first.
    for (let index = 0; index < 14; index += 1) {
      createOrder(
        db,
        {
          id: `order-busy-${index}`,
          runId: "run",
          queueId: "queue",
          itemId: `busy-${index}`,
          title: `Keep working on ${index}`,
          station: "build",
        },
        "2026-09-18T09:00:00.000Z",
      );
      appendOrderEvent(
        db,
        `order-busy-${index}`,
        { kind: "started", status: "working" },
        `2026-09-18T09:${String(index + 10).padStart(2, "0")}:00.000Z`,
      );
    }

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:00:00.000Z"));
    const active = snapshot.orders.filter((order) => order.stage === "active");

    expect(active[0]?.id).toBe("order-fenced-early");
    expect(active).toHaveLength(12);
    expect(snapshot.totals.active).toBe(15);
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
  const seedWorkedOrder = (db: Database): void => {
    createOrder(
      db,
      {
        id: "order-worked",
        runId: "run",
        queueId: "queue",
        itemId: "worked",
        title: "Work an item through",
        agentId: "builder",
        station: "build",
        worktree: trunk.dir,
        branch: "worked",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendOrderEvent(
      db,
      "order-worked",
      { kind: "started", status: "working", actorId: "builder" },
      "2026-09-18T10:01:00.000Z",
    );
    recordOrderEnvironment(
      db,
      "order-worked",
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
    recordOrderCheck(
      db,
      "order-worked",
      { command: "bun run verify", exitCode: 1, result: "typecheck failed" },
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderCheck(
      db,
      "order-worked",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:04:00.000Z",
    );
    recordOrderFile(
      db,
      "order-worked",
      { path: "src/factory-wall.ts", added: 62, removed: 7 },
      "2026-09-18T10:05:00.000Z",
    );
    recordOrderCommit(
      db,
      "order-worked",
      trunk.sha,
      "feat: read one order's record",
      "2026-09-18T10:06:00.000Z",
    );
    // The check that lets this order complete: recorded after the commit it covers,
    // which is the order the gate reads and the loop already works in.
    recordOrderCheck(
      db,
      "order-worked",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:06:30.000Z",
    );
    recordOrderFinding(
      db,
      "order-worked",
      { dimension: "tests", summary: "the rail has no test", answer: "fixed" },
      "2026-09-18T10:07:00.000Z",
    );
    recordOrderFinding(
      db,
      "order-worked",
      {
        dimension: "style",
        summary: "the dialog should use a component library",
        answer: "refused",
        resolution: "the design doc rules a library out for this surface",
      },
      "2026-09-18T10:08:00.000Z",
    );
    recordOrderDocument(db, "order-worked", "docs/human-interface.md", "2026-09-18T10:09:00.000Z");
    appendOrderEvent(
      db,
      "order-worked",
      { kind: "completed", status: "completed", reason: "verified" },
      "2026-09-18T10:10:00.000Z",
    );
  };

  test("reads one order's lifecycle in the order it was written", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    seedWorkedOrder(db);

    const view = assembleItemView(db, "order-worked", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.entries.map((entry) => entry.kind)).toEqual([
      "claimed",
      "started",
      "environment_reported",
      "check_finished",
      "check_finished",
      "commit_created",
      "check_finished",
      "review_finished",
      "review_finished",
      "document_updated",
      "completed",
    ]);
    db.close();
  });

  test("carries the order's identity above what is being read", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    seedWorkedOrder(db);

    const view = assembleItemView(db, "order-worked", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.order.title).toBe("Work an item through");
    expect(view?.order.station).toBe("build");
    expect(view?.order.status).toBe("completed");
    expect(view?.order.worker).toBe(workerName("builder"));
    expect([view?.runId, view?.queueId, view?.order.itemId]).toEqual(["run", "queue", "worked"]);
    expect([view?.worktree, view?.branch]).toEqual([trunk.dir, "worked"]);
    db.close();
  });

  test("reads the changes beside the history rather than as moments in it", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    seedWorkedOrder(db);

    const view = assembleItemView(db, "order-worked", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.changes).toEqual([{ path: "src/factory-wall.ts", added: 62, removed: 7 }]);
    expect(view?.entries.some((entry) => entry.path === "src/factory-wall.ts")).toBe(false);
    db.close();
  });

  test("leaves an uncounted change without a count rather than calling it zero", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    createOrder(db, {
      id: "order-uncounted",
      runId: "run",
      queueId: "queue",
      itemId: "uncounted",
      title: "Record a path and no counts",
    });
    appendOrderEvent(db, "order-uncounted", { kind: "started", status: "working" });
    recordOrderFile(db, "order-uncounted", { path: "src/binary.png" });

    const view = assembleItemView(db, "order-uncounted", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.changes).toEqual([{ path: "src/binary.png" }]);
    db.close();
  });

  test("writes a path under the home directory the way a person does", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const home = resolveHomeDir();
    createOrder(db, {
      id: "order-at-home",
      runId: "run",
      queueId: "queue",
      itemId: "at-home",
      title: "Read a path as a person writes it",
      worktree: `${home}/code/dim-factory`,
      branch: "at-home",
    });
    appendOrderEvent(db, "order-at-home", { kind: "started", status: "working" });
    recordOrderFile(db, "order-at-home", { path: `${home}/code/dim-factory/src/paths.ts` });

    const view = assembleItemView(db, "order-at-home", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.worktree).toBe("~/code/dim-factory");
    expect(view?.changes).toEqual([{ path: "~/code/dim-factory/src/paths.ts" }]);
    db.close();
  });

  test("attaches each commit, check and finding to the event that produced it", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    seedWorkedOrder(db);

    const entries = assembleItemView(db, "order-worked", new Date("2026-09-18T10:20:00.000Z"))?.entries ?? [];

    expect(entries.find((entry) => entry.kind === "commit_created")?.commit).toEqual({
      sha: trunk.sha,
      subject: "feat: read one order's record",
    });
    expect(entries.filter((entry) => entry.kind === "check_finished").map((entry) => entry.check)).toEqual([
      { command: "bun run verify", exitCode: 1, result: "typecheck failed" },
      { command: "bun run verify", exitCode: 0, result: "green" },
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
    createOrder(
      db,
      {
        id: "order-delegating",
        runId: "run",
        queueId: "queue",
        itemId: "delegating",
        title: "Hand work to a reviewer",
        agentId: "builder",
        station: "build",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendOrderEvent(
      db,
      "order-delegating",
      { kind: "started", status: "working" },
      "2026-09-18T10:01:00.000Z",
    );
    appendOrderEvent(
      db,
      "order-delegating",
      { kind: "delegated", actorId: "builder", delegatedAgentId: "reviewer", delegatedStation: "review" },
      "2026-09-18T10:02:00.000Z",
    );

    const view = assembleItemView(db, "order-delegating", new Date("2026-09-18T10:20:00.000Z"));
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
    createOrder(
      db,
      {
        id: "order-fenced",
        runId: "run",
        queueId: "queue",
        itemId: "fenced",
        title: "Stop at a fence",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendOrderEvent(
      db,
      "order-fenced",
      { kind: "fenced", status: "fenced", fenceType: "owner-judgment", reason: "scope unclear" },
      "2026-09-18T10:01:00.000Z",
    );

    const view = assembleItemView(db, "order-fenced", new Date("2026-09-18T10:20:00.000Z"));
    const fence = view?.entries.find((entry) => entry.kind === "fenced");

    expect([fence?.fence, fence?.reason]).toEqual(["owner-judgment", "scope unclear"]);
    db.close();
  });

  test("has nothing to show for an order it holds no record of", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);

    expect(assembleItemView(db, "order-absent", new Date("2026-09-18T10:20:00.000Z"))).toBeNull();
    db.close();
  });

  test("reads only the order asked for, where another order's evidence shares its ids", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    seedWorkedOrder(db);
    createOrder(
      db,
      {
        id: "order-other",
        runId: "run",
        queueId: "queue",
        itemId: "other",
        title: "Work a second item",
        worktree: "/tmp/other",
        branch: "other",
      },
      "2026-09-18T10:00:00.000Z",
    );
    appendOrderEvent(db, "order-other", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderCheck(
      db,
      "order-other",
      { command: "bun run other", exitCode: 0, result: "green" },
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderFile(db, "order-other", { path: "src/other.ts" }, "2026-09-18T10:05:00.000Z");
    recordOrderDocument(db, "order-other", "docs/other.md", "2026-09-18T10:09:00.000Z");

    const entries = assembleItemView(db, "order-other", new Date("2026-09-18T10:20:00.000Z"))?.entries ?? [];

    expect(entries.map((entry) => entry.kind)).toEqual([
      "claimed",
      "started",
      "check_finished",
      "document_updated",
    ]);
    expect(entries.map((entry) => entry.check?.command).filter(Boolean)).toEqual(["bun run other"]);
    expect(entries.map((entry) => entry.path).filter(Boolean)).toEqual(["docs/other.md"]);
    db.close();
  });

  test("serves one order's record and holds an order id it cannot read to 404", async () => {
    const file = `${tmpdir()}/wall-item-${Date.now()}.sqlite`;
    const seed = new Database(file);
    seed.run(SCHEMA_SQL);
    seedWorkedOrder(seed);
    seed.close();
    const server = await serveWall({ port: 0, databasePath: file });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const found = await fetch(`${origin}/api/order/order-worked`);
      expect(found.status).toBe(200);
      const view = await found.json();
      expect(view.order.title).toBe("Work an item through");
      expect(view.entries.at(-1)).toEqual({
        at: "2026-09-18T10:10:00.000Z",
        kind: "completed",
        reason: "verified",
      });

      expect((await fetch(`${origin}/api/order/order-absent`)).status).toBe(404);
      expect((await fetch(`${origin}/api/order/`)).status).toBe(404);
      // A percent sequence that is not valid UTF-8 is an id, not a crash.
      expect((await fetch(`${origin}/api/order/%E0%A4%A`)).status).toBe(404);
    } finally {
      server.stop(true);
      rmSync(file, { force: true });
    }
  });

  test("says the database is unavailable rather than serving an empty record", async () => {
    const server = await serveWall({ port: 0, databasePath: `${tmpdir()}/wall-absent-${Date.now()}.sqlite` });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const item = await fetch(`${origin}/api/order/order-worked`);
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
