import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { runFactoryOrder } from "./factory-operator";
import {
  appendOrderEvent,
  createOrder,
  moveOrder,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderEnvironment,
  recordOrderFile,
  recordOrderFinding,
  updateOrderLocation,
} from "./factory-order";
import { clearStop, FactoryStopError, pullStop } from "./factory-stop";
import { commitOffTrunk, integratedRepo, repoWithoutTrunk } from "./fixtures.test-support";
import { dbPath } from "./paths";
import { SCHEMA_SQL } from "./schema";
import { rebuild } from "./sync";
import type { WorkerHookReport } from "./worker-environment";

function db(): Database {
  const database = new Database(":memory:");
  database.run(SCHEMA_SQL);
  return database;
}

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

const order = {
  id: "order-1",
  runId: "run-1",
  queueId: "queue-1",
  itemId: "item-1",
  title: "Record a factory order",
  agentId: "agent-1",
  sessionId: "session-1",
  worktree: trunk.dir,
  branch: "order-1",
  station: "dim-station-build",
};

/** What the gate wants before an order may complete: a commit on the trunk, then a check that passed. */
function landed(database: Database, orderId: string, at?: string): void {
  recordOrderCommit(database, orderId, trunk.sha, "feat: land it", at);
  recordOrderCheck(database, orderId, { command: "bun run verify", exitCode: 0, result: "green" }, at);
}

const setupReport: WorkerHookReport = {
  phase: "setup",
  argv: ["/tmp/wt/scripts/worktree-setup.sh"],
  exitCode: 0,
  signal: null,
  stdout: '{"resources":[{"container":"dim-wt-order-1"}]}\n',
  stderr: "",
  resources: [{ container: "dim-wt-order-1" }],
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

describe("factory order report records", () => {
  test("runs one item through a builder and records its observable lifecycle", async () => {
    const database = db();
    const result = await runFactoryOrder(
      database,
      {
        id: "order-2",
        runId: "run-2",
        queueId: "build-order",
        itemId: "self-sufficient-factory-order",
        title: "Make an order self-sufficient",
        agentId: "agent-2",
      },
      { baseRevision: "abc123" },
      async (context) => {
        expect(context.item.itemId).toBe("self-sufficient-factory-order");
        expect(context.baseRevision).toBe("abc123");
        context.setLocation(trunk.dir, "order-2");
        context.delegate("agent-3", "session-3", "dim-station-review");
        context.recordCommit(trunk.sha, "feat: observable order");
        context.recordFile({ path: "src/factory-operator.ts", added: 18, removed: 2 });
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
        .query("SELECT status, stop_reason, worktree, branch FROM factory_order WHERE id = 'order-2'")
        .get(),
    ).toEqual({
      status: "completed",
      stop_reason: "verified",
      worktree: trunk.dir,
      branch: "order-2",
    });
    expect(
      database.query("SELECT kind, status FROM factory_order_event WHERE order_id = 'order-2'").all(),
    ).toEqual([
      { kind: "claimed", status: null },
      { kind: "started", status: "working" },
      { kind: "delegated", status: null },
      { kind: "commit_created", status: null },
      { kind: "check_finished", status: null },
      { kind: "review_finished", status: null },
      { kind: "completed", status: "completed" },
    ]);
    expect(database.query("SELECT sha FROM factory_order_commit WHERE order_id = 'order-2'").get()).toEqual({
      sha: trunk.sha,
    });
    expect(database.query("SELECT path FROM factory_order_file WHERE order_id = 'order-2'").get()).toEqual({
      path: "src/factory-operator.ts",
    });
    expect(
      database.query("SELECT command FROM factory_order_check WHERE order_id = 'order-2'").get(),
    ).toEqual({
      command: "bun run verify",
    });
    expect(
      database.query("SELECT dimension FROM factory_order_finding WHERE order_id = 'order-2'").get(),
    ).toEqual({
      dimension: "tests",
    });
    expect(
      database.query("SELECT path FROM factory_order_document WHERE order_id = 'order-2'").get(),
    ).toEqual({
      path: "docs/factory.md",
    });
    expect(
      database
        .query("SELECT phase, resources FROM factory_order_environment WHERE order_id = 'order-2'")
        .get(),
    ).toEqual({ phase: "setup", resources: '[{"container":"dim-wt-order-1"}]' });
    database.close();
  });

  test("projects every returned terminal outcome", async () => {
    const database = db();
    for (const [index, status] of (["completed", "blocked", "fenced", "failed"] as const).entries()) {
      const orderId = `order-terminal-${index}`;
      const outcome = await runFactoryOrder(
        database,
        {
          id: orderId,
          runId: `run-${orderId}`,
          queueId: "queue-1",
          itemId: orderId,
          title: `Run ${orderId} beside the others`,
          worktree: trunk.dir,
          branch: orderId,
        },
        { baseRevision: "abc123" },
        (context) => {
          if (status === "completed") {
            context.recordCommit(trunk.sha, "feat: land it");
            context.recordCheck({ command: "bun run verify", exitCode: 0, result: "green" });
          }
          return { status, reason: "stopped" };
        },
      );
      expect(outcome).toEqual({ status, reason: "stopped" });
      expect(
        database.query("SELECT status, stop_reason FROM factory_order WHERE id = ?").get(orderId),
      ).toEqual({
        status,
        stop_reason: "stopped",
      });
      expect(
        database.query("SELECT kind, status FROM factory_order_event WHERE order_id = ?").all(orderId),
      ).toEqual([
        { kind: "claimed", status: null },
        { kind: "started", status: "working" },
        ...(status === "completed"
          ? [
              { kind: "commit_created", status: null },
              { kind: "check_finished", status: null },
            ]
          : []),
        { kind: status, status },
      ]);
    }
    database.close();
  });

  test("fails a builder that returns completed with no check recorded", async () => {
    const database = db();

    await expect(
      runFactoryOrder(
        database,
        {
          id: "order-unchecked",
          runId: "run-unchecked",
          queueId: "queue-1",
          itemId: "item-1",
          title: "Complete without checking",
          worktree: "/tmp/wt",
          branch: "order-unchecked",
        },
        { baseRevision: "abc123" },
        () => ({ status: "completed", reason: "verified" }),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "order_not_checked" }));

    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-unchecked'").get()).toEqual({
      status: "failed",
    });
    database.close();
  });

  test("records a failed builder before rethrowing its error", async () => {
    const database = db();
    await expect(
      runFactoryOrder(
        database,
        { id: "order-3", runId: "run-3", queueId: "queue-1", itemId: "item-3", title: "Fail in the builder" },
        { baseRevision: "abc123" },
        () => {
          throw new Error("builder stopped");
        },
      ),
    ).rejects.toThrow("builder stopped");
    expect(
      database.query("SELECT status, stop_reason FROM factory_order WHERE id = 'order-3'").get(),
    ).toEqual({
      status: "failed",
      stop_reason: "builder stopped",
    });
    expect(database.query("SELECT kind FROM factory_order_event WHERE order_id = 'order-3'").all()).toEqual([
      { kind: "claimed" },
      { kind: "started" },
      { kind: "failed" },
    ]);
    database.close();
  });

  test("requires one worktree before an order can stop", async () => {
    const database = db();

    await expect(
      runFactoryOrder(
        database,
        {
          id: "order-no-worktree",
          runId: "run-no-worktree",
          queueId: "queue-1",
          itemId: "item-1",
          title: "Complete without a worktree",
        },
        { baseRevision: "abc123" },
        () => ({ status: "completed", reason: "verified" }),
      ),
    ).rejects.toThrow("order order-no-worktree has no worktree");
    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-no-worktree'").get()).toEqual({
      status: "failed",
    });
    database.close();
  });

  test("keeps the owned worktree and rejects lifecycle events out of order", () => {
    const database = db();
    createOrder(database, order, "2026-09-18T10:00:00.000Z");

    expect(() => appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" })).toThrow(
      "order order-1 must be working before it can complete",
    );
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" });
    expect(() => updateOrderLocation(database, "order-1", "/other", "other")).toThrow(
      "order order-1 already owns a worktree",
    );
    database.close();
  });

  test("refuses to complete an order whose commits never reached the trunk", () => {
    const repo = integratedRepo();
    const database = db();
    const landed = { ...order, worktree: repo.dir };
    createOrder(database, landed, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", commitOffTrunk(repo.dir, "item-statement"), "feat: land it");
    recordOrderCheck(database, "order-1", { command: "bun run verify", exitCode: 0, result: "green" });

    expect(() => appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" })).toThrow(
      expect.objectContaining({ code: "order_not_integrated" }),
    );
    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "working" });

    recordOrderCommit(database, "order-1", repo.sha, "feat: on the trunk");
    recordOrderCheck(database, "order-1", { command: "bun run verify", exitCode: 0, result: "green" });
    appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" });

    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "completed" });
    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("counts a check by when it was recorded, not by when it says it ran", () => {
    const repo = integratedRepo();
    const database = db();
    createOrder(database, { ...order, worktree: repo.dir }, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", repo.sha, "feat: land it", "2026-09-18T10:03:00.000Z");
    // The order the station loop runs in: the check finishes, then the commit it
    // vouches for is made, then both are recorded.
    recordOrderCheck(
      database,
      "order-1",
      {
        command: "bun run verify",
        exitCode: 0,
        result: "green",
        finishedAt: "2026-09-18T10:02:00.000Z",
      },
      "2026-09-18T10:04:00.000Z",
    );

    appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" });

    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "completed" });
    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("says what it cannot read when a trunk is named but not present", () => {
    const repo = repoWithoutTrunk();
    Bun.spawnSync([
      "git",
      "-C",
      repo.dir,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    ]);
    const database = db();
    createOrder(database, { ...order, worktree: repo.dir }, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", repo.sha, "feat: land it");
    recordOrderCheck(database, "order-1", { command: "bun run verify", exitCode: 0, result: "green" });

    expect(() => appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" })).toThrow(
      /names trunk as its trunk but has no local branch/,
    );
    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("says the worktree is gone rather than that it names no trunk", () => {
    const database = db();
    const gone = join(tmpdir(), `dim-gone-${Date.now()}`);
    createOrder(database, { ...order, worktree: gone }, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", trunk.sha, "feat: land it");
    recordOrderCheck(database, "order-1", { command: "bun run verify", exitCode: 0, result: "green" });

    expect(() => appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" })).toThrow(
      /is not a git repo that can be read/,
    );
    database.close();
  });

  test("says a commit is missing rather than unmerged when the repo lacks it", () => {
    const repo = integratedRepo();
    const database = db();
    createOrder(database, { ...order, worktree: repo.dir }, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", "0000000000000000000000000000000000000000", "feat: mistyped");
    recordOrderCheck(database, "order-1", { command: "bun run verify", exitCode: 0, result: "green" });

    expect(() => appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" })).toThrow(
      /does not have, so nothing there can place them/,
    );
    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("refuses to complete an order that recorded no commit at all", () => {
    const repo = integratedRepo();
    const database = db();
    createOrder(database, { ...order, worktree: repo.dir }, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderCheck(database, "order-1", { command: "bun run verify", exitCode: 0, result: "green" });

    expect(() => appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" })).toThrow(
      expect.objectContaining({ code: "order_not_integrated" }),
    );
    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("refuses to complete where the repo does not name a trunk to reach", () => {
    const repo = repoWithoutTrunk();
    const database = db();
    createOrder(database, { ...order, worktree: repo.dir }, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", repo.sha, "feat: land it");
    recordOrderCheck(database, "order-1", { command: "bun run verify", exitCode: 0, result: "green" });

    expect(() => appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" })).toThrow(
      expect.objectContaining({ code: "order_trunk_unknown" }),
    );
    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "working" });
    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("refuses to complete an order no passing check was recorded for", () => {
    const database = db();
    createOrder(database, order, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 1, result: "2 failed" },
      "2026-09-18T10:02:00.000Z",
    );
    recordOrderCommit(database, "order-1", trunk.sha, "feat: land it", "2026-09-18T10:02:30.000Z");

    expect(() => appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" })).toThrow(
      expect.objectContaining({ code: "order_not_checked" }),
    );
    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "working" });

    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:03:00.000Z",
    );
    appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" });

    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "completed" });
    database.close();
  });

  test("refuses a check that passed before the order's last commit", () => {
    const database = db();
    createOrder(database, order, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:02:00.000Z",
    );
    recordOrderCommit(database, "order-1", trunk.sha, "feat: land it", "2026-09-18T10:03:00.000Z");

    expect(() => appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" })).toThrow(
      expect.objectContaining({ code: "order_not_checked" }),
    );

    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      "2026-09-18T10:04:00.000Z",
    );
    appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" });

    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "completed" });
    database.close();
  });

  test("lets every other terminal status stop an unchecked order", () => {
    for (const status of ["blocked", "fenced", "failed"] as const) {
      const database = db();
      createOrder(database, order, "2026-09-18T10:00:00.000Z");
      appendOrderEvent(
        database,
        "order-1",
        { kind: "started", status: "working" },
        "2026-09-18T10:01:00.000Z",
      );

      appendOrderEvent(database, "order-1", { kind: status, status });

      expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status });
      database.close();
    }
  });

  test("records an explicit stop and rejects evidence after it", () => {
    const database = db();
    createOrder(database, order, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    appendOrderEvent(
      database,
      "order-1",
      { kind: "fenced", status: "fenced", fenceType: "owner-decision", reason: "needs approval" },
      "2026-09-18T10:02:00.000Z",
    );
    expect(() => recordOrderFile(database, "order-1", { path: "src/after-stop.ts" })).toThrow(
      "order order-1 is already fenced",
    );
    expect(() => recordOrderEnvironment(database, "order-1", teardownReport)).toThrow(
      "order order-1 is already fenced",
    );
    expect(() => updateOrderLocation(database, "order-1", "/other", "other")).toThrow(
      "order order-1 is already terminal",
    );
    expect(database.query("SELECT count(*) AS count FROM factory_order_file").get()).toEqual({ count: 0 });
    expect(database.query("SELECT count(*) AS count FROM factory_order_environment").get()).toEqual({
      count: 0,
    });
    database.close();
  });

  test("preserves a builder error after the builder records a terminal outcome", async () => {
    const database = db();
    await expect(
      runFactoryOrder(
        database,
        {
          id: "order-4",
          runId: "run-4",
          queueId: "queue-1",
          itemId: "item-4",
          title: "Record evidence as it lands",
          worktree: "/repo/.claude/worktrees/order-4",
          branch: "order-4",
        },
        { baseRevision: "abc123" },
        (context) => {
          context.appendEvent({ kind: "blocked", status: "blocked", reason: "builder stopped" });
          throw new Error("builder failed after stopping");
        },
      ),
    ).rejects.toThrow("builder failed after stopping");
    expect(
      database.query("SELECT status, stop_reason FROM factory_order WHERE id = 'order-4'").get(),
    ).toEqual({
      status: "blocked",
      stop_reason: "builder stopped",
    });
    expect(database.query("SELECT kind FROM factory_order_event WHERE order_id = 'order-4'").all()).toEqual([
      { kind: "claimed" },
      { kind: "started" },
      { kind: "blocked" },
    ]);
    database.close();
  });

  test("creates a claim and keeps its identity and current status", () => {
    const database = db();
    createOrder(database, order, "2026-09-18T10:00:00.000Z");
    expect(
      database
        .query("SELECT run_id, queue_id, item_id, worktree, branch, station, status FROM factory_order")
        .get(),
    ).toEqual({
      run_id: "run-1",
      queue_id: "queue-1",
      item_id: "item-1",
      worktree: trunk.dir,
      branch: "order-1",
      station: "dim-station-build",
      status: "waiting",
    });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'factory_lane%'")
        .all(),
    ).toEqual([]);
    expect(database.query("SELECT kind, actor_id, session_id FROM factory_order_event").get()).toEqual({
      kind: "claimed",
      actor_id: "agent-1",
      session_id: "session-1",
    });
    database.close();
  });

  test("moves a running order to another station and keeps where it came from", () => {
    const database = db();
    createOrder(database, order, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");

    moveOrder(database, "order-1", "dim-station-review", "2026-09-18T10:02:00.000Z");

    expect(database.query("SELECT station, updated_at FROM factory_order").get()).toEqual({
      station: "dim-station-review",
      updated_at: "2026-09-18T10:02:00.000Z",
    });
    expect(database.query("SELECT kind, station FROM factory_order_event ORDER BY id").all()).toEqual([
      { kind: "claimed", station: "dim-station-build" },
      { kind: "started", station: null },
      { kind: "moved", station: "dim-station-review" },
    ]);
    database.close();
  });

  test("refuses a move before the order started and after it stopped", () => {
    const database = db();
    createOrder(database, order, "2026-09-18T10:00:00.000Z");

    expect(() => moveOrder(database, "order-1", "dim-station-review")).toThrow(
      "order order-1 must be working before it can move",
    );
    expect(database.query("SELECT station FROM factory_order").get()).toEqual({
      station: "dim-station-build",
    });

    appendOrderEvent(database, "order-1", { kind: "started", status: "working" });
    landed(database, "order-1");
    appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" });

    expect(() => moveOrder(database, "order-1", "dim-station-review")).toThrow(/already completed/);
    expect(database.query("SELECT station FROM factory_order").get()).toEqual({
      station: "dim-station-build",
    });
    database.close();
  });

  test("stores normalized evidence and projects terminal status from events", () => {
    const database = db();
    createOrder(database, order, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", trunk.sha, "feat: order", "2026-09-18T10:02:00.000Z");
    recordOrderFile(
      database,
      "order-1",
      { path: "src/factory-order.ts", added: 40, removed: 9 },
      "2026-09-18T10:02:30.000Z",
    );
    const check = recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "426 tests" },
      "2026-09-18T10:03:00.000Z",
    );
    const finding = recordOrderFinding(
      database,
      "order-1",
      { dimension: "tests", summary: "coverage is present", answer: "fixed" },
      "2026-09-18T10:04:00.000Z",
    );
    recordOrderDocument(database, "order-1", "docs/factory.md", "2026-09-18T10:05:00.000Z");
    appendOrderEvent(
      database,
      "order-1",
      { kind: "completed", status: "completed", reason: "verified", checkId: check, findingId: finding },
      "2026-09-18T10:06:00.000Z",
    );
    expect(database.query("SELECT status, completed_at, stop_reason FROM factory_order").get()).toEqual({
      status: "completed",
      completed_at: "2026-09-18T10:06:00.000Z",
      stop_reason: "verified",
    });
    expect(database.query("SELECT sha FROM factory_order_commit").get()).toEqual({ sha: trunk.sha });
    expect(database.query("SELECT path FROM factory_order_file").get()).toEqual({
      path: "src/factory-order.ts",
    });
    expect(database.query("SELECT command, exit_code FROM factory_order_check").get()).toEqual({
      command: "bun run verify",
      exit_code: 0,
    });
    expect(database.query("SELECT dimension, answer FROM factory_order_finding").get()).toEqual({
      dimension: "tests",
      answer: "fixed",
    });
    expect(database.query("SELECT path FROM factory_order_document").get()).toEqual({
      path: "docs/factory.md",
    });
    database.close();
  });

  test("attaches a worktree's setup and teardown reports to the order", () => {
    const database = db();
    createOrder(database, order, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderEnvironment(database, "order-1", setupReport, "2026-09-18T10:02:00.000Z");
    recordOrderEnvironment(database, "order-1", teardownReport, "2026-09-18T10:07:00.000Z");

    expect(
      database
        .query(
          `SELECT phase, argv, exit_code, signal, stdout, stderr, resources, recorded_at
           FROM factory_order_environment WHERE order_id = 'order-1' ORDER BY recorded_at`,
        )
        .all(),
    ).toEqual([
      {
        phase: "setup",
        argv: '["/tmp/wt/scripts/worktree-setup.sh"]',
        exit_code: 0,
        signal: null,
        stdout: '{"resources":[{"container":"dim-wt-order-1"}]}\n',
        stderr: "",
        resources: '[{"container":"dim-wt-order-1"}]',
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

  test("rejects lifecycle events after an order reaches a terminal status", () => {
    const database = db();
    for (const [index, status] of (["completed", "blocked", "fenced", "failed"] as const).entries()) {
      const orderId = `order-terminal-${index}`;
      createOrder(
        database,
        { ...order, id: orderId, runId: `run-${orderId}`, itemId: orderId },
        "2026-09-18T10:00:00.000Z",
      );
      appendOrderEvent(database, orderId, { kind: "started", status: "working" }, "2026-09-18T10:00:30.000Z");
      // A completed order needs its commit and check on the record before the gate lets it stop.
      const staged = status === "completed" ? 2 : 0;
      if (staged) landed(database, orderId, "2026-09-18T10:00:45.000Z");
      appendOrderEvent(database, orderId, { kind: status, status }, "2026-09-18T10:01:00.000Z");

      expect(() => appendOrderEvent(database, orderId, { kind: "started", status: "working" })).toThrow();
      expect(() => appendOrderEvent(database, orderId, { kind: "started" })).toThrow();
      expect(
        database.query("SELECT status, completed_at FROM factory_order WHERE id = ?").get(orderId),
      ).toEqual({
        status,
        completed_at: "2026-09-18T10:01:00.000Z",
      });
      expect(
        database.query("SELECT count(*) AS count FROM factory_order_event WHERE order_id = ?").get(orderId),
      ).toEqual({
        count: 3 + staged,
      });
    }
    database.close();
  });

  test("rejects terminal events whose kind and status disagree", () => {
    const database = db();
    createOrder(database, order, "2026-09-18T10:00:00.000Z");

    expect(() => appendOrderEvent(database, "order-1", { kind: "completed", status: "failed" })).toThrow(
      "terminal event kind must match its status",
    );
    expect(() => appendOrderEvent(database, "order-1", { kind: "completed" })).toThrow(
      "terminal event kind must match its status",
    );
    expect(() => appendOrderEvent(database, "order-1", { kind: "started", status: "completed" })).toThrow(
      "terminal event status must match its kind",
    );
    expect(() => appendOrderEvent(database, "order-1", { kind: "failed", status: "completed" })).toThrow(
      "terminal event kind must match its status",
    );
    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      status: "waiting",
    });
    expect(
      database.query("SELECT count(*) AS count FROM factory_order_event WHERE order_id = 'order-1'").get(),
    ).toEqual({
      count: 1,
    });
    database.close();
  });

  test("rolls back an event when projecting it fails", () => {
    const database = db();
    createOrder(database, order, "2026-09-18T10:00:00.000Z");
    database.run(
      `CREATE TRIGGER reject_order_projection BEFORE UPDATE ON factory_order
       BEGIN SELECT RAISE(ABORT, 'projection rejected'); END`,
    );

    expect(() =>
      appendOrderEvent(
        database,
        "order-1",
        { kind: "started", status: "working" },
        "2026-09-18T10:01:00.000Z",
      ),
    ).toThrow();
    expect(database.query("SELECT count(*) AS count FROM factory_order_event").get()).toEqual({ count: 1 });
    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "waiting" });
    database.close();
  });

  test("rolls back evidence when its lifecycle event cannot project", () => {
    const database = db();
    createOrder(database, order, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" });
    database.run(
      `CREATE TRIGGER reject_order_evidence_projection BEFORE UPDATE ON factory_order
       BEGIN SELECT RAISE(ABORT, 'projection rejected'); END`,
    );

    expect(() => recordOrderCommit(database, "order-1", "abc123", "feat: order")).toThrow(
      "projection rejected",
    );
    expect(database.query("SELECT count(*) AS count FROM factory_order_commit").get()).toEqual({ count: 0 });
    expect(
      database.query("SELECT count(*) AS count FROM factory_order_event WHERE kind = 'commit_created'").get(),
    ).toEqual({
      count: 0,
    });
    database.close();
  });

  test("refused findings require a resolution", () => {
    const database = db();
    createOrder(database, order);
    expect(() =>
      recordOrderFinding(database, "order-1", { dimension: "docs", summary: "missing", answer: "refused" }),
    ).toThrow();
    database.close();
  });

  test("keeps the report through rebuild because no source can recreate it", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-order-"));
    const environment = { HOME: home, DIM_HOME: home };
    const database = openDb(dbPath(environment));
    createOrder(database, order, "2026-09-18T10:00:00.000Z");
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" }, "2026-09-18T10:01:00.000Z");
    recordOrderEnvironment(database, "order-1", teardownReport, "2026-09-18T10:02:00.000Z");
    closeDb(database);
    const rebuilt = openDb(dbPath(environment), { forRebuild: true });
    rebuild(rebuilt, environment);
    expect(rebuilt.query("SELECT status FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      status: "working",
    });
    expect(
      rebuilt.query("SELECT phase, signal FROM factory_order_environment WHERE order_id = 'order-1'").get(),
    ).toEqual({ phase: "teardown", signal: "SIGKILL" });
    expect(rebuilt.query("SELECT kind FROM factory_order_event WHERE order_id = 'order-1'").get()).toEqual({
      kind: "claimed",
    });
    closeDb(rebuilt);
    rmSync(home, { recursive: true, force: true });
  });

  test("refuses a claim while the floor is stopped, writing nothing", () => {
    const database = db();
    pullStop(database, { reason: "the commit gate records nothing" });

    expect(() => createOrder(database, order)).toThrow(FactoryStopError);
    expect(database.query("SELECT count(*) AS n FROM factory_order").get()).toEqual({ n: 0 });
    expect(database.query("SELECT count(*) AS n FROM factory_order_event").get()).toEqual({ n: 0 });

    database.close();
  });

  test("takes a claim once the stop is cleared", () => {
    const database = db();
    pullStop(database, { reason: "the commit gate records nothing" });
    clearStop(database);

    createOrder(database, order);

    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      status: "waiting",
    });
    database.close();
  });

  test("lets an order already running record and stop while the floor is stopped", () => {
    const database = db();
    createOrder(database, order);
    appendOrderEvent(database, "order-1", { kind: "started", status: "working" });
    pullStop(database, { reason: "the commit gate records nothing" });

    landed(database, "order-1");
    appendOrderEvent(database, "order-1", { kind: "completed", status: "completed" });

    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      status: "completed",
    });
    database.close();
  });
});
