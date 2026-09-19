import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  appendOrderEvent,
  claimOrder,
  type OrderRole,
  queueOrder,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderEnvironment,
  recordOrderFile,
  recordOrderFinding,
  setOrderPriority,
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
    queueOrder(
      db,
      { id: "order-running", project: "cniska/dim-factory", title: "Show the wall" },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(
      db,
      "order-running",
      { runId: "run", agentId: "builder", role: "builder", station: "build" },
      "2026-09-18T10:00:00.000Z",
    );

    recordOrderCheck(
      db,
      "order-running",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:02:00.000Z",
    );
    queueOrder(
      db,
      { id: "order-blocked", project: "cniska/dim-factory", title: "Unblock the queue" },
      "2026-09-18T09:00:00.000Z",
    );
    claimOrder(db, "order-blocked", { runId: "run", station: "review" }, "2026-09-18T09:00:00.000Z");
    appendOrderEvent(
      db,
      "order-blocked",
      { kind: "failed", holdType: "owner-judgment", reason: "scope unclear" },
      "2026-09-18T09:05:00.000Z",
    );
    queueOrder(
      db,
      { id: "order-done", project: "cniska/dim-factory", title: "Ship the board" },
      "2026-09-18T08:00:00.000Z",
    );
    claimOrder(db, "order-done", { runId: "run", station: "ship" }, "2026-09-18T08:00:00.000Z");
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
      trunk.dir,
    );

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:10:00.000Z"));

    expect(snapshot.source).toBe("database");
    expect(snapshot.orders.map((order) => [order.title, order.station, order.status, order.stage])).toEqual([
      ["Unblock the queue", "review", "queued", "todo"],
      ["Show the wall", "build", "working", "active"],
      ["Ship the board", "ship", "completed", "done"],
    ]);
    expect(snapshot.orders[0]?.attention).toBe("scope unclear");
    expect(snapshot.orders[1]).toEqual({
      id: "order-running",
      title: "Show the wall",
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

  test("puts a claimed order in the active column", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    queueOrder(
      db,
      { id: "order-claimed", project: "cniska/dim-factory", title: "Wait for a builder" },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-claimed", { runId: "run", station: "plan" }, "2026-09-18T10:00:00.000Z");

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z"));

    expect(snapshot.orders.map((order) => [order.status, order.stage])).toEqual([["working", "active"]]);
    db.close();
  });

  test("puts a handed-back order in the todo column with why it stopped", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    queueOrder(
      db,
      { id: "order-gone", project: "cniska/dim-factory", title: "Stop this one" },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-gone", { runId: "run", station: "build" }, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(
      db,
      "order-gone",
      { kind: "failed", reason: "operator stopped" },
      "2026-09-18T10:02:00.000Z",
    );

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z"));

    expect(snapshot.orders.map((order) => [order.status, order.stage, order.attention])).toEqual([
      ["queued", "todo", "operator stopped"],
    ]);
    db.close();
  });

  test("has an event to age every claimed order from", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    queueOrder(
      db,
      { id: "order-quiet", project: "cniska/dim-factory", title: "Go quiet after being claimed" },
      "2026-09-18T09:00:00.000Z",
    );
    claimOrder(db, "order-quiet", { runId: "run", station: "build" }, "2026-09-18T09:05:00.000Z");
    // Writes the order row without recording an event, which is how an order's row can be newer
    // than anything that happened to it.
    setOrderPriority(db, "order-quiet", "high");
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
    queueOrder(
      db,
      { id: "order-struggling", project: "cniska/dim-factory", title: "Fail the check twice" },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-struggling", { runId: "run", station: "build" }, "2026-09-18T10:00:00.000Z");

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

    queueOrder(
      db,
      { id: "order-clean", project: "cniska/dim-factory", title: "Pass the check first time" },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-clean", { runId: "run", station: "build" }, "2026-09-18T10:00:00.000Z");
    recordOrderCheck(
      db,
      "order-clean",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:02:00.000Z",
    );

    const failures = new Map(
      assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z")).orders.map((order) => [
        order.id,
        order.failedChecks,
      ]),
    );

    expect(failures.get("order-struggling")).toBe(2);
    expect(failures.get("order-clean")).toBe(0);
    db.close();
  });

  test("names no worker for an order no claim and no event named an agent for", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    queueOrder(
      db,
      { id: "order-unattributed", project: "cniska/dim-factory", title: "Claimed by nobody in particular" },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(
      db,
      "order-unattributed",
      { runId: "run", station: "dim-station-build" },
      "2026-09-18T10:00:00.000Z",
    );

    const order = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z")).orders[0];

    expect(order).toEqual({
      id: "order-unattributed",
      title: "Claimed by nobody in particular",
      station: "build",
      stage: "active",
      // Nobody was named, so nothing says what kind of worker this is either.
      role: "unknown",
      status: "working",
      age: "5m",
      lastEventAt: "2026-09-18T10:00:00.000Z",
      failedChecks: 0,
    });
    db.close();
  });

  test("reads a role off the claim, never off the station or the agent's name", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const take = (id: string, recorded: OrderRole | undefined, stationValue: string, agentId: string) => {
      queueOrder(db, { id, project: "cniska/dim-factory", title: id }, "2026-09-18T10:00:00.000Z");
      claimOrder(
        db,
        id,
        { runId: "run", agentId, ...(recorded ? { role: recorded } : {}), station: stationValue },
        "2026-09-18T10:00:00.000Z",
      );
    };
    // A builder sitting at the review station is still a builder, and a name that reads
    // like a role is a string somebody typed.
    take("planning", "planner", "dim-station-build", "agent-1");
    take("building", "builder", "dim-station-review", "planner-2");
    take("reviewing", "reviewer", "dim-station-plan", "agent-3");
    take("unrecorded", undefined, "dim-station-build", "builder-4");

    const roles = new Map(
      assembleWallSnapshot(db, new Date("2026-09-18T10:20:00.000Z")).orders.map((order) => [
        order.id,
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
    queueOrder(
      db,
      { id: "order-line", project: "cniska/dim-factory", title: "Claimed with a line, not a station" },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-line", { runId: "run", station: "dim-line-feat" }, "2026-09-18T10:00:00.000Z");
    queueOrder(
      db,
      { id: "order-stationless", project: "cniska/dim-factory", title: "Claimed with no station at all" },
      "2026-09-18T09:00:00.000Z",
    );
    claimOrder(db, "order-stationless", { runId: "run" }, "2026-09-18T09:00:00.000Z");

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z"));

    expect(snapshot.orders.map((order) => order.station)).toEqual(["unknown", "unknown"]);
    expect(STATION_LABELS.unknown).toBe("Unknown");
    db.close();
  });

  test("bounds each stage column so finished work cannot crowd out current work", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const seed = (id: string, kind: "failed" | "completed") => {
      queueOrder(db, { id, project: "cniska/dim-factory", title: id }, "2026-09-18T09:00:00.000Z");
      claimOrder(db, id, { runId: "run", station: "build" }, "2026-09-18T09:00:00.000Z");
      if (kind === "completed") {
        recordOrderCommit(db, id, trunk.sha, "feat: land it", "2026-09-18T09:00:40.000Z");
        recordOrderCheck(
          db,
          id,
          { command: "bun run verify", exitCode: 0, result: "green" },
          "2026-09-18T09:00:45.000Z",
        );
      }
      appendOrderEvent(
        db,
        id,
        {
          kind,
          ...(kind === "completed" ? { status: "completed" as const } : {}),
          reason: `reason-${id}`,
        },
        "2026-09-18T09:01:00.000Z",
        trunk.dir,
      );
    };
    for (let index = 0; index < 14; index += 1) seed(`failed-${index}`, "failed");
    for (let index = 0; index < 14; index += 1) seed(`done-${index}`, "completed");

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:10:00.000Z"));

    expect(snapshot.orders.filter((order) => order.stage === "todo")).toHaveLength(12);
    expect(snapshot.orders.filter((order) => order.stage === "done")).toHaveLength(12);
    expect(snapshot.totals).toEqual({ todo: 14, active: 0, done: 14 });
    db.close();
  });

  test("keeps an order that needs a person on the board and at the top of its column", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    queueOrder(
      db,
      { id: "order-failed-early", project: "cniska/dim-factory", title: "Stop and wait for the owner" },
      "2026-09-18T08:00:00.000Z",
    );
    claimOrder(db, "order-failed-early", { runId: "run", station: "build" }, "2026-09-18T08:00:00.000Z");
    appendOrderEvent(
      db,
      "order-failed-early",
      { kind: "failed", reason: "scope unclear" },
      "2026-09-18T08:02:00.000Z",
    );
    // More waiting work than a column draws, every piece of it newer than the order that
    // stopped, which is what a bound applied before the ranking would drop first.
    for (let index = 0; index < 14; index += 1) {
      queueOrder(
        db,
        { id: `order-busy-${index}`, project: "cniska/dim-factory", title: `Busy ${index}` },
        `2026-09-18T09:${String(index + 10).padStart(2, "0")}:00.000Z`,
      );
    }

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:00:00.000Z"));
    const todo = snapshot.orders.filter((order) => order.stage === "todo");

    expect(todo[0]?.id).toBe("order-failed-early");
    expect(todo).toHaveLength(12);
    expect(snapshot.totals.todo).toBe(15);
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
    queueOrder(
      db,
      { id: "order-worked", project: "cniska/dim-factory", title: "Work an item through" },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(
      db,
      "order-worked",
      { runId: "run", agentId: "builder", station: "build" },
      "2026-09-18T10:00:00.000Z",
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
      trunk.dir,
    );
  };

  test("reads one order's lifecycle in the order it was written", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    seedWorkedOrder(db);

    const view = assembleItemView(db, "order-worked", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.entries.map((entry) => entry.kind)).toEqual([
      "queued",
      "claimed",
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
    expect([view?.runId, view?.project, view?.order.id]).toEqual([
      "run",
      "cniska/dim-factory",
      "order-worked",
    ]);
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
    queueOrder(db, {
      id: "order-uncounted",
      project: "cniska/dim-factory",
      title: "Record a path and no counts",
    });
    claimOrder(db, "order-uncounted", { runId: "run" });
    recordOrderFile(db, "order-uncounted", { path: "src/binary.png" });

    const view = assembleItemView(db, "order-uncounted", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.changes).toEqual([{ path: "src/binary.png" }]);
    db.close();
  });

  test("writes a path under the home directory the way a person does", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const home = resolveHomeDir();
    queueOrder(db, {
      id: "order-at-home",
      project: "cniska/dim-factory",
      title: "Read a path as a person writes it",
    });
    claimOrder(db, "order-at-home", { runId: "run" });
    recordOrderFile(db, "order-at-home", { path: `${home}/code/dim-factory/src/paths.ts` });

    const view = assembleItemView(db, "order-at-home", new Date("2026-09-18T10:20:00.000Z"));

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

  test("names the worker the harness recorded against a moment", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    queueOrder(
      db,
      { id: "order-reviewed", project: "cniska/dim-factory", title: "Hand work to a reviewer" },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-reviewed", { runId: "run", station: "build" }, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(db, "order-reviewed", { kind: "moved", station: "review" }, "2026-09-18T10:02:00.000Z");
    // Written by the sync join rather than by the command, which is the whole point: the
    // worker a moment names is a fact the harness recorded, not one the writer stated.
    db.run(
      `INSERT INTO factory_order_event_worker (event_id, worker_id, session_id, tool_use_id)
       SELECT id, 'reviewer', 'session-1', 'toolu_1' FROM factory_order_event WHERE kind = 'moved'`,
    );

    const view = assembleItemView(db, "order-reviewed", new Date("2026-09-18T10:20:00.000Z"));
    const moved = view?.entries.find((entry) => entry.kind === "moved");

    expect(moved?.worker).toBe(workerName("reviewer"));
    db.close();
  });

  test("names the session where the harness recorded no agent of its own", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    queueOrder(
      db,
      { id: "order-root", project: "cniska/dim-factory", title: "Worked from a root session" },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-root", { runId: "run", station: "build" }, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(db, "order-root", { kind: "moved", station: "review" }, "2026-09-18T10:02:00.000Z");
    db.run(
      `INSERT INTO factory_order_event_worker (event_id, worker_id, session_id, tool_use_id)
       SELECT id, NULL, 'session-root', 'toolu_2' FROM factory_order_event WHERE kind = 'moved'`,
    );

    const view = assembleItemView(db, "order-root", new Date("2026-09-18T10:20:00.000Z"));
    const board = assembleWallSnapshot(db, new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.entries.find((entry) => entry.kind === "moved")?.worker).toBe(workerName("session-root"));
    expect(board.orders.find((order) => order.id === "order-root")?.worker).toBe(workerName("session-root"));
    db.close();
  });

  test("keeps the grounds a hold stopped on", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    queueOrder(
      db,
      { id: "order-held", project: "cniska/dim-factory", title: "Stop at a hold" },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-held", { runId: "run" }, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(
      db,
      "order-held",
      { kind: "failed", holdType: "owner-judgment", reason: "scope unclear" },
      "2026-09-18T10:01:00.000Z",
    );

    const view = assembleItemView(db, "order-held", new Date("2026-09-18T10:20:00.000Z"));
    const held = view?.entries.find((entry) => entry.kind === "failed");

    expect([held?.hold, held?.reason]).toEqual(["owner-judgment", "scope unclear"]);
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
    queueOrder(
      db,
      { id: "order-other", project: "cniska/dim-factory", title: "Work a second item" },
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-other", { runId: "run" }, "2026-09-18T10:01:00.000Z");
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
      "queued",
      "claimed",
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
