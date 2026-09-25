import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  answerOrderFinding,
  appendOrderEvent,
  approveOrderBuild,
  approveOrderReview,
  claimOrder as claimOrderAt,
  closeOrderReview,
  moveOrder,
  type OrderClaim,
  queueOrder,
  raiseOrderFinding,
  recordOrderBuild,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderEnvironment,
  recordOrderFile,
  recordOrderReviewArtifact,
  setOrderPriority,
} from "./factory-order";
import { assembleItemView, assembleWallSnapshot, serveWall } from "./factory-wall";
import { integratedRepo, reviewIn, workerIn } from "./fixtures.test-support";
import { resolveHomeDir } from "./paths";
import type { Role } from "./roles";
import { SCHEMA_SQL } from "./schema";

// One hand per database, set where the database is made: every moment names a worker,
// and what these tests are about is what the wall draws rather than who touched it.
let worker = "";
let attemptOperator = "";

function floor(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  worker = workerIn(db);
  attemptOperator = workerIn(db, "operator");
  return db;
}

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

// A claim now makes the worktree it names, so every direct call needs somewhere
// safe to make one — `trunk.dir` rather than this machine's own checkout.
function claimOrder(
  db: Database,
  orderId: string,
  given: Omit<OrderClaim, "operatorWorker">,
  who: string,
  at?: string,
): number {
  return claimOrderAt(db, orderId, { ...given, operatorWorker: attemptOperator }, who, at, trunk.dir);
}

describe("factory wall snapshot", () => {
  test("assembles current work for the board from read-only order records", () => {
    const db = floor();
    queueOrder(
      db,
      { id: "order-running", project: "cniska/dim-factory", title: "Show the wall" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-running", { runId: "run", station: "build" }, worker, "2026-09-18T10:00:00.000Z");

    recordOrderCheck(
      db,
      "order-running",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T10:02:00.000Z",
    );
    queueOrder(
      db,
      { id: "order-blocked", project: "cniska/dim-factory", title: "Unblock the queue" },
      worker,
      "2026-09-18T09:00:00.000Z",
    );
    claimOrder(db, "order-blocked", { runId: "run", station: "review" }, worker, "2026-09-18T09:00:00.000Z");
    appendOrderEvent(
      db,
      "order-blocked",
      { worker, kind: "failed", holdType: "owner-judgment", reason: "scope unclear" },
      "2026-09-18T09:05:00.000Z",
    );
    queueOrder(
      db,
      { id: "order-done", project: "cniska/dim-factory", title: "Ship the board" },
      worker,
      "2026-09-18T08:00:00.000Z",
    );
    claimOrder(db, "order-done", { runId: "run", station: "build" }, worker, "2026-09-18T08:00:00.000Z");
    recordOrderCommit(db, "order-done", trunk.sha, worker, "wall", "2026-09-18T08:01:00.000Z");
    recordOrderCheck(
      db,
      "order-done",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T08:01:30.000Z",
    );
    recordOrderBuild(
      db,
      "order-done",
      "The board change is built and verified.",
      trunk.sha,
      worker,
      "2026-09-18T08:01:32.000Z",
    );
    const operator = workerIn(db, "operator");
    approveOrderBuild(db, "order-done", operator, "the board change is complete", "2026-09-18T08:01:35.000Z");
    const review = reviewIn(db, "order-done", operator, "2026-09-18T08:01:36.000Z", trunk.sha);
    recordOrderReviewArtifact(
      db,
      "order-done",
      "## Outcome\n\nThe change is ready.",
      review.reviewer,
      "2026-09-18T08:01:36.500Z",
    );
    closeOrderReview(db, review.review, "closed", operator, "2026-09-18T08:01:37.000Z");
    approveOrderReview(db, "order-done", operator, "2026-09-18T08:01:38.000Z");
    moveOrder(db, "order-done", "ship", operator, "2026-09-18T08:01:45.000Z");
    appendOrderEvent(
      db,
      "order-done",
      { worker, kind: "completed", status: "completed", reason: "verified" },
      "2026-09-18T08:02:00.000Z",
      trunk.dir,
    );

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:10:00.000Z"));

    expect(snapshot.source).toBe("database");
    expect(snapshot.orders.map((order) => [order.title, order.station, order.status, order.stage])).toEqual([
      ["Show the wall", "build", "working", "active"],
      ["Unblock the queue", "review", "queued", "active"],
      ["Ship the board", null, "completed", "done"],
    ]);
    expect(snapshot.orders[0]).toEqual({
      id: "order-running",
      title: "Show the wall",
      line: "feat",
      station: "build",
      stage: "active",
      agent: worker,
      worker,
      role: "builder",
      status: "working",
      age: "8m",
      lastEventAt: "2026-09-18T10:02:00.000Z",
      failedChecks: 0,
    });
    db.close();
  });

  test("keeps an order description on the card record while it is working", () => {
    const db = floor();
    queueOrder(
      db,
      {
        id: "order-described",
        project: "cniska/dim-factory",
        title: "Show the description",
        description: "A human-facing explanation of the requested outcome.",
      },
      worker,
    );
    claimOrder(db, "order-described", { runId: "run", station: "review" }, worker);

    const view = assembleWallSnapshot(db).orders[0];
    expect(view).toMatchObject({
      title: "Show the description",
      description: "A human-facing explanation of the requested outcome.",
      station: "review",
    });

    db.close();
  });

  test("puts a claimed order in the active column", () => {
    const db = floor();
    queueOrder(
      db,
      { id: "order-claimed", project: "cniska/dim-factory", title: "Wait for a builder" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-claimed", { runId: "run", station: "plan" }, worker, "2026-09-18T10:00:00.000Z");

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z"));

    expect(snapshot.orders.map((order) => [order.status, order.stage])).toEqual([["working", "active"]]);
    db.close();
  });

  test("keeps a handed-back order active after its first claim", () => {
    const db = floor();
    queueOrder(
      db,
      { id: "order-gone", project: "cniska/dim-factory", title: "Stop this one" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-gone", { runId: "run", station: "build" }, worker, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(
      db,
      "order-gone",
      { worker, kind: "failed", reason: "operator stopped" },
      "2026-09-18T10:02:00.000Z",
    );

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z"));

    expect(snapshot.orders.map((order) => [order.status, order.stage])).toEqual([["queued", "active"]]);
    db.close();
  });

  test("has an event to age every claimed order from", () => {
    const db = floor();
    queueOrder(
      db,
      { id: "order-quiet", project: "cniska/dim-factory", title: "Go quiet after being claimed" },
      worker,
      "2026-09-18T09:00:00.000Z",
    );
    claimOrder(db, "order-quiet", { runId: "run", station: "build" }, worker, "2026-09-18T09:05:00.000Z");
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
    const db = floor();
    queueOrder(
      db,
      { id: "order-struggling", project: "cniska/dim-factory", title: "Fail the check twice" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(
      db,
      "order-struggling",
      { runId: "run", station: "build" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );

    recordOrderCheck(
      db,
      "order-struggling",
      { command: "bun run verify", exitCode: 1, result: "lint failed" },
      worker,
      "2026-09-18T10:02:00.000Z",
    );
    recordOrderCheck(
      db,
      "order-struggling",
      { command: "bun run verify", exitCode: 2, result: "typecheck failed" },
      worker,
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderCheck(
      db,
      "order-struggling",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T10:04:00.000Z",
    );

    queueOrder(
      db,
      { id: "order-clean", project: "cniska/dim-factory", title: "Pass the check first time" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-clean", { runId: "run", station: "build" }, worker, "2026-09-18T10:00:00.000Z");
    recordOrderCheck(
      db,
      "order-clean",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
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

  test("a runner failure can omit a worker without inventing one on the card", () => {
    const db = floor();
    queueOrder(
      db,
      { id: "order-named", project: "cniska/dim-factory", title: "Name the hand that took it" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );

    expect(() =>
      db.run(
        `INSERT INTO factory_order_event (order_id, ts, kind, worker)
         VALUES ('order-named', '2026-09-18T10:01:00.000Z', 'failed', NULL)`,
      ),
    ).not.toThrow();
    const card = assembleWallSnapshot(db, new Date("2026-09-18T10:02:00.000Z")).orders.find(
      (order) => order.id === "order-named",
    );
    expect(card).toBeDefined();
    expect(card).not.toHaveProperty("worker");
    // What `openDb` runs on every connection; a name no worker row backs is refused only
    // while it is on, which is why it is turned on there rather than left to the caller.
    db.run("PRAGMA foreign_keys = ON");
    expect(() =>
      db.run(
        `INSERT INTO factory_order_event (order_id, ts, kind, worker)
         VALUES ('order-named', '2026-09-18T10:01:00.000Z', 'claimed', 'nobody-9')`,
      ),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  test("reads a role off the worker, never off the station it is sitting at", () => {
    const db = floor();
    const take = (id: string, called: Role, stationValue: string) => {
      const hand = workerIn(db, called);
      queueOrder(db, { id, project: "cniska/dim-factory", title: id }, hand, "2026-09-18T10:00:00.000Z");
      claimOrder(db, id, { runId: "run", station: stationValue }, hand, "2026-09-18T10:00:00.000Z");
    };
    // A builder sitting at the review station is still a builder.
    take("planning", "planner", "dim-station-build");
    take("building", "builder", "dim-station-review");
    take("reviewing", "reviewer", "dim-station-plan");
    take("operating", "operator", "dim-station-build");

    const roles = new Map(
      assembleWallSnapshot(db, new Date("2026-09-18T10:20:00.000Z")).orders.map((order) => [
        order.id,
        order.role,
      ]),
    );

    expect(roles.get("planning")).toBe("planner");
    expect(roles.get("building")).toBe("builder");
    expect(roles.get("reviewing")).toBe("reviewer");
    expect(roles.get("operating")).toBe("operator");
    db.close();
  });

  test("omits a station it does not know rather than calling it build", () => {
    const db = floor();
    queueOrder(
      db,
      { id: "order-line", project: "cniska/dim-factory", title: "Claimed with a line, not a station" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(
      db,
      "order-line",
      { runId: "run", station: "dim-line-feat" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    queueOrder(
      db,
      { id: "order-stationless", project: "cniska/dim-factory", title: "Claimed with no station at all" },
      worker,
      "2026-09-18T09:00:00.000Z",
    );
    claimOrder(db, "order-stationless", { runId: "run" }, worker, "2026-09-18T09:00:00.000Z");

    const snapshot = assembleWallSnapshot(db, new Date("2026-09-18T10:05:00.000Z"));

    expect(snapshot.orders.map((order) => order.station)).toEqual([null, null]);
    db.close();
  });

  test("bounds each stage column so finished work cannot crowd out current work", () => {
    const db = floor();
    const seed = (id: string, kind: "failed" | "completed") => {
      queueOrder(db, { id, project: "cniska/dim-factory", title: id }, worker, "2026-09-18T09:00:00.000Z");
      claimOrder(db, id, { runId: "run", station: "build" }, worker, "2026-09-18T09:00:00.000Z");
      if (kind === "completed") {
        recordOrderCommit(db, id, trunk.sha, worker, "feat: land it", "2026-09-18T09:00:40.000Z");
        recordOrderCheck(
          db,
          id,
          { command: "bun run verify", exitCode: 0, result: "green" },
          worker,
          "2026-09-18T09:00:45.000Z",
        );
        recordOrderBuild(
          db,
          id,
          "The change is built and verified.",
          trunk.sha,
          worker,
          "2026-09-18T09:00:47.000Z",
        );
      }
      appendOrderEvent(
        db,
        id,
        {
          worker,
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

    expect(snapshot.orders.filter((order) => order.stage === "active")).toHaveLength(12);
    expect(snapshot.orders.filter((order) => order.stage === "done")).toHaveLength(12);
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
  const seedWorkedOrder = (db: Database, includeReviewArtifact = false): string => {
    queueOrder(
      db,
      { id: "order-worked", project: "cniska/dim-factory", title: "Work an item through" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    db.run(
      "INSERT INTO factory_order_plan (order_id, revision, worker, body, recorded_at) VALUES (?, ?, ?, ?, ?)",
      ["order-worked", 1, worker, "## Outcome\n\nRead the order record.", "2026-09-18T10:00:30.000Z"],
    );
    claimOrder(db, "order-worked", { runId: "run", station: "build" }, worker, "2026-09-18T10:00:00.000Z");

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
      worker,
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderCheck(
      db,
      "order-worked",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T10:04:00.000Z",
    );
    recordOrderFile(
      db,
      "order-worked",
      { path: "src/factory-wall.ts", added: 62, removed: 7 },
      worker,
      "2026-09-18T10:05:00.000Z",
    );
    recordOrderCommit(
      db,
      "order-worked",
      trunk.sha,
      worker,
      "feat: read one order's record",
      "2026-09-18T10:06:00.000Z",
    );
    // The check that lets this order complete: recorded after the commit it covers,
    // which is the order the gate reads and the loop already works in.
    recordOrderCheck(
      db,
      "order-worked",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T10:06:30.000Z",
    );
    recordOrderBuild(
      db,
      "order-worked",
      "## Summary\n\nThe order record is visible.",
      trunk.sha,
      worker,
      "2026-09-18T10:06:35.000Z",
    );
    const review = reviewIn(db, "order-worked", worker, "2026-09-18T10:06:45.000Z");
    const reviewer = review.reviewer;
    const onTests = raiseOrderFinding(
      db,
      "order-worked",
      { dimension: "tests", summary: "the rail has no test" },
      reviewer,
      "2026-09-18T10:07:00.000Z",
    );
    answerOrderFinding(db, onTests, { answer: "fixed" }, worker, "2026-09-18T10:07:00.000Z");
    const onStyle = raiseOrderFinding(
      db,
      "order-worked",
      {
        dimension: "style",
        summary: "the dialog should use a component library",
      },
      reviewer,
      "2026-09-18T10:08:00.000Z",
    );
    answerOrderFinding(
      db,
      onStyle,
      { answer: "refused", resolution: "the design doc rules a library out for this surface" },
      worker,
      "2026-09-18T10:08:00.000Z",
    );
    recordOrderDocument(db, "order-worked", "docs/human-interface.md", worker, "2026-09-18T10:09:00.000Z");
    if (includeReviewArtifact) {
      recordOrderReviewArtifact(
        db,
        "order-worked",
        "## Outcome\n\nThe reviewed change is ready.",
        reviewer,
        "2026-09-18T10:09:30.000Z",
      );
    }
    appendOrderEvent(
      db,
      "order-worked",
      { worker, kind: "completed", status: "completed", reason: "verified" },
      "2026-09-18T10:10:00.000Z",
      trunk.dir,
    );
    return reviewer;
  };

  test("reads one order's lifecycle in the order it was written", () => {
    const db = floor();
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
      "build_artifact_written",
      "review_opened",
      "finding_raised",
      "finding_answered",
      "finding_raised",
      "finding_answered",
      "document_updated",
      "completed",
    ]);
    db.close();
  });

  test("carries the order's identity above what is being read", () => {
    const db = floor();
    const reviewer = seedWorkedOrder(db, true);

    const view = assembleItemView(db, "order-worked", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.order.title).toBe("Work an item through");
    expect(view?.order.station).toBeNull();
    expect(view?.order.status).toBe("completed");
    expect(view?.order.worker).toBe(worker);
    expect(view?.plan).toEqual({
      revision: 1,
      body: "## Outcome\n\nRead the order record.",
      worker,
      role: "builder",
      approved: false,
    });
    expect(view?.build).toEqual({
      revision: 1,
      body: "## Summary\n\nThe order record is visible.",
      headSha: trunk.sha,
      worker,
      role: "builder",
      approved: false,
    });
    expect(view?.review).toEqual({
      revision: 1,
      body: "## Outcome\n\nThe reviewed change is ready.",
      worker: reviewer,
      role: "reviewer",
      approved: false,
    });
    expect([view?.runId, view?.project, view?.order.id]).toEqual([
      "run",
      "cniska/dim-factory",
      "order-worked",
    ]);
    db.close();
  });

  test("reads the changes beside the history rather than as moments in it", () => {
    const db = floor();
    seedWorkedOrder(db);

    const view = assembleItemView(db, "order-worked", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.changes).toEqual([{ path: "src/factory-wall.ts", added: 62, removed: 7 }]);
    expect(view?.entries.some((entry) => entry.path === "src/factory-wall.ts")).toBe(false);
    db.close();
  });

  test("leaves an uncounted change without a count rather than calling it zero", () => {
    const db = floor();
    queueOrder(
      db,
      {
        id: "order-uncounted",
        project: "cniska/dim-factory",
        title: "Record a path and no counts",
      },
      worker,
    );
    claimOrder(db, "order-uncounted", { runId: "run", station: "build" }, worker);
    recordOrderFile(db, "order-uncounted", { path: "src/binary.png" }, worker);

    const view = assembleItemView(db, "order-uncounted", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.changes).toEqual([{ path: "src/binary.png" }]);
    db.close();
  });

  test("writes a path under the home directory the way a person does", () => {
    const db = floor();
    const home = resolveHomeDir();
    queueOrder(
      db,
      {
        id: "order-at-home",
        project: "cniska/dim-factory",
        title: "Read a path as a person writes it",
      },
      worker,
    );
    claimOrder(db, "order-at-home", { runId: "run", station: "build" }, worker);
    recordOrderFile(db, "order-at-home", { path: `${home}/code/dim-factory/src/paths.ts` }, worker);

    const view = assembleItemView(db, "order-at-home", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.changes).toEqual([{ path: "~/code/dim-factory/src/paths.ts" }]);
    db.close();
  });

  test("attaches each commit, check and finding to the event that produced it", () => {
    const db = floor();
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
    expect(
      entries.filter((entry) => entry.kind === "finding_answered").map((entry) => entry.finding),
    ).toEqual([
      { dimension: "tests", answer: "fixed", summary: "the rail has no test" },
      {
        dimension: "style",
        answer: "refused",
        summary: "the dialog should use a component library",
        resolution: "the design doc rules a library out for this surface",
      },
    ]);
    expect(entries.find((entry) => entry.kind === "document_updated")).toMatchObject({
      path: "docs/human-interface.md",
      worker,
      role: "builder",
    });
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

  test("each moment names the worker that recorded it, not the one holding the order", () => {
    const db = floor();
    const reviewer = workerIn(db, "reviewer");
    queueOrder(
      db,
      { id: "order-reviewed", project: "cniska/dim-factory", title: "Hand work to a reviewer" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-reviewed", { runId: "run", station: "build" }, worker, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(
      db,
      "order-reviewed",
      { worker: reviewer, kind: "moved", station: "review" },
      "2026-09-18T10:02:00.000Z",
    );

    const view = assembleItemView(db, "order-reviewed", new Date("2026-09-18T10:20:00.000Z"));

    expect(view?.entries.find((entry) => entry.kind === "moved")?.worker).toBe(reviewer);
    expect(view?.entries.find((entry) => entry.kind === "claimed")?.worker).toBe(worker);
    // A reviewer writing a moment does not take the order, so the card keeps naming the
    // worker whose claim holds it, and the role comes off that claim.
    expect(view?.order.worker).toBe(worker);
    expect(view?.order.role).toBe("builder");
    db.close();
  });

  test("keeps the grounds a hold stopped on", () => {
    const db = floor();
    queueOrder(
      db,
      { id: "order-held", project: "cniska/dim-factory", title: "Stop at a hold" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-held", { runId: "run" }, worker, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(
      db,
      "order-held",
      { worker, kind: "failed", holdType: "owner-judgment", reason: "scope unclear" },
      "2026-09-18T10:01:00.000Z",
    );

    const view = assembleItemView(db, "order-held", new Date("2026-09-18T10:20:00.000Z"));
    const held = view?.entries.find((entry) => entry.kind === "failed");

    expect([held?.hold, held?.reason]).toEqual(["owner-judgment", "scope unclear"]);
    db.close();
  });

  test("has nothing to show for an order it holds no record of", () => {
    const db = floor();

    expect(assembleItemView(db, "order-absent", new Date("2026-09-18T10:20:00.000Z"))).toBeNull();
    db.close();
  });

  test("reads only the order asked for, where another order's evidence shares its ids", () => {
    const db = floor();
    seedWorkedOrder(db);
    queueOrder(
      db,
      { id: "order-other", project: "cniska/dim-factory", title: "Work a second item" },
      worker,
      "2026-09-18T10:00:00.000Z",
    );
    claimOrder(db, "order-other", { runId: "run", station: "build" }, worker, "2026-09-18T10:01:00.000Z");
    recordOrderCheck(
      db,
      "order-other",
      { command: "bun run other", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderFile(db, "order-other", { path: "src/other.ts" }, worker, "2026-09-18T10:05:00.000Z");
    recordOrderDocument(db, "order-other", "docs/other.md", worker, "2026-09-18T10:09:00.000Z");

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
    worker = workerIn(seed);
    attemptOperator = workerIn(seed, "operator");
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
        agent: worker,
        role: "builder",
        worker,
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
