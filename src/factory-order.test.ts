import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { runFactoryOrder } from "./factory-operator";
import {
  amendOrder,
  answerOrderFinding,
  appendOrderEvent,
  claimOrder as claimOrderAt,
  dropOrder,
  isTerminalOrderStatus,
  moveOrder,
  type OrderClaim,
  queueOrder,
  raiseOrderFinding,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderEnvironment,
  recordOrderFile,
  recordOrderPlan,
  shipOrder,
} from "./factory-order";
import { clearStop, FactoryStopError, pullStop } from "./factory-stop";
import { endWorker } from "./factory-worker";
import {
  commitOffTrunk,
  integratedRepo,
  orderWorktree,
  repoWithoutTrunk,
  reviewIn,
  scratchEnv,
  workerIn,
} from "./fixtures.test-support";
import { dbPath } from "./paths";
import { SCHEMA_SQL } from "./schema";
import { rebuild } from "./sync";
import type { WorkerHookReport } from "./worker-environment";

// One hand per database, set where the database is made: every moment names a worker,
// and what these tests are about is the order rather than who touched it.
let worker = "";

function db(): Database {
  const database = new Database(":memory:");
  database.run(SCHEMA_SQL);
  worker = workerIn(database);
  return database;
}

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

const order = {
  id: "order-1",
  project: "cniska/dim-factory",
  title: "Record a factory order",
};

const claim = { runId: "run-1", sessionId: "session-1", station: "dim-station-build" };

// A claim now makes the worktree it names, so every direct call needs somewhere
// safe to make one — `trunk.dir` rather than this machine's own checkout.
function claimOrder(
  database: Database,
  orderId: string,
  given: OrderClaim,
  who: string,
  at?: string,
): number {
  return claimOrderAt(database, orderId, given, who, at, trunk.dir);
}

/** What the gate wants before an order may complete: a commit on the trunk, then a check that passed. */
function landed(database: Database, orderId: string, at?: string): void {
  recordOrderCommit(database, orderId, trunk.sha, worker, "feat: land it", at);
  recordOrderCheck(
    database,
    orderId,
    { command: "bun run verify", exitCode: 0, result: "green" },
    worker,
    at,
  );
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
  test("refuses implementation evidence while an order is still in plan", () => {
    const database = db();
    queueOrder(database, { ...order, id: "order-plan" }, worker);
    claimOrder(database, "order-plan", { ...claim, station: "dim-station-plan" }, worker);

    expect(() =>
      recordOrderCommit(database, "order-plan", trunk.sha, worker, "docs: record the plan"),
    ).toThrow(expect.objectContaining({ code: "order_not_building" }));
    database.close();
  });

  test("records a plan only at the plan station and permits implementation after moving to build", () => {
    const database = db();
    queueOrder(database, { ...order, id: "order-planned" }, worker);
    claimOrder(database, "order-planned", { ...claim, station: "dim-station-plan" }, worker);

    recordOrderPlan(database, "order-planned", "## outcome\n\nMove the order before building.", worker);
    expect(
      database.query("SELECT body, worker FROM factory_order_plan WHERE order_id = 'order-planned'").get(),
    ).toEqual({ body: "## outcome\n\nMove the order before building.", worker });
    expect(
      database.query("SELECT kind FROM factory_order_event WHERE order_id = 'order-planned'").all(),
    ).toEqual([{ kind: "queued" }, { kind: "claimed" }, { kind: "plan_submitted" }]);

    moveOrder(database, "order-planned", "dim-station-build", worker);
    recordOrderCommit(database, "order-planned", trunk.sha, worker, "feat: planned order");
    database.close();
  });

  test("the next station's worker takes an order the move handed on", () => {
    const database = db();
    const builder = workerIn(database, "builder");
    queueOrder(database, { ...order, id: "order-handed" }, worker);
    claimOrder(database, "order-handed", { ...claim, station: "dim-station-plan" }, worker);
    moveOrder(database, "order-handed", "dim-station-build", worker);

    claimOrder(database, "order-handed", { ...claim, runId: "run-2", station: "dim-station-build" }, builder);

    expect(
      database.query("SELECT status, station, run_id FROM factory_order WHERE id = 'order-handed'").get(),
    ).toEqual({ status: "working", station: "dim-station-build", run_id: "run-2" });
    expect(
      database
        .query(
          "SELECT worker, station FROM factory_order_event WHERE order_id = 'order-handed' AND kind = 'claimed' ORDER BY id",
        )
        .all(),
    ).toEqual([
      { worker, station: "dim-station-plan" },
      { worker: builder, station: "dim-station-build" },
    ]);
    database.close();
  });

  test("a second hand cannot take an order at the station already working it", () => {
    const database = db();
    const builder = workerIn(database, "builder");
    queueOrder(database, { ...order, id: "order-taken" }, worker);
    claimOrder(database, "order-taken", { ...claim, station: "dim-station-build" }, worker);

    expect(() =>
      claimOrder(
        database,
        "order-taken",
        { ...claim, runId: "run-2", station: "dim-station-build" },
        builder,
      ),
    ).toThrow(/already working under run-1/);
    database.close();
  });

  test("runs one item through a builder and records its observable lifecycle", async () => {
    const database = db();
    queueOrder(database, { ...order, id: "order-2" }, worker);
    const result = await runFactoryOrder(
      database,
      { id: "order-2" },
      { baseRevision: "abc123", claim, worker, worktree: trunk.dir },
      async (context) => {
        expect(context.item.id).toBe("order-2");
        expect(context.baseRevision).toBe("abc123");
        context.recordCommit(trunk.sha, "feat: observable order");
        context.recordFile({ path: "src/factory-operator.ts", added: 18, removed: 2 });
        context.recordCheck({ command: "bun run verify", exitCode: 0, result: "green" });
        const round = reviewIn(database, "order-2", worker);
        const raised = raiseOrderFinding(
          database,
          "order-2",
          { dimension: "tests", summary: "holds" },
          round.reviewer,
        );
        context.answerFinding(raised, { answer: "fixed" });
        context.recordDocument("docs/factory.md");
        context.recordEnvironment(setupReport);
        context.stop({ status: "completed", reason: "verified" });
        return { status: "completed", reason: "verified" };
      },
    );

    expect(result).toEqual({ status: "completed", reason: "verified" });
    expect(
      database.query("SELECT status, stop_reason FROM factory_order WHERE id = 'order-2'").get(),
    ).toEqual({
      status: "completed",
      stop_reason: "verified",
    });
    expect(
      database.query("SELECT kind, status FROM factory_order_event WHERE order_id = 'order-2'").all(),
    ).toEqual([
      { kind: "queued", status: null },
      { kind: "claimed", status: null },
      { kind: "commit_created", status: null },
      { kind: "check_finished", status: null },
      { kind: "review_opened", status: null },
      { kind: "finding_raised", status: null },
      { kind: "finding_answered", status: null },
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

  test("projects a completion as done and a failure back into the queue", async () => {
    const database = db();
    for (const [index, status] of (["completed", "failed"] as const).entries()) {
      const orderId = `order-terminal-${index}`;
      queueOrder(database, { ...order, id: orderId }, worker);
      const outcome = await runFactoryOrder(
        database,
        { id: orderId },
        { baseRevision: "abc123", claim, worker, worktree: trunk.dir },
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
        status: status === "completed" ? "completed" : "queued",
        stop_reason: "stopped",
      });
      expect(
        database.query("SELECT kind, status FROM factory_order_event WHERE order_id = ?").all(orderId),
      ).toEqual([
        { kind: "queued", status: null },
        { kind: "claimed", status: null },
        ...(status === "completed"
          ? [
              { kind: "commit_created", status: null },
              { kind: "check_finished", status: null },
            ]
          : []),
        { kind: status, status: status === "completed" ? "completed" : null },
      ]);
    }
    database.close();
  });

  test("fails a builder that returns completed with no check recorded", async () => {
    const database = db();

    queueOrder(database, { ...order, id: "order-unchecked" }, worker);

    await expect(
      runFactoryOrder(
        database,
        { id: "order-unchecked" },
        { baseRevision: "abc123", claim, worker, worktree: trunk.dir },
        () => ({
          status: "completed",
          reason: "verified",
        }),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "order_not_checked" }));

    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-unchecked'").get()).toEqual({
      status: "queued",
    });
    database.close();
  });

  test("records a failed builder before rethrowing its error", async () => {
    const database = db();
    queueOrder(database, { ...order, id: "order-3" }, worker);
    await expect(
      runFactoryOrder(
        database,
        { id: "order-3" },
        { baseRevision: "abc123", claim, worker, worktree: trunk.dir },
        () => {
          throw new Error("builder stopped");
        },
      ),
    ).rejects.toThrow("builder stopped");
    expect(
      database.query("SELECT status, stop_reason FROM factory_order WHERE id = 'order-3'").get(),
    ).toEqual({
      status: "queued",
      stop_reason: "builder stopped",
    });
    expect(database.query("SELECT kind FROM factory_order_event WHERE order_id = 'order-3'").all()).toEqual([
      { kind: "queued" },
      { kind: "claimed" },
      { kind: "failed" },
    ]);
    database.close();
  });

  test("refuses a completion with no check behind it", async () => {
    const database = db();

    queueOrder(database, { ...order, id: "order-no-worktree" }, worker);

    await expect(
      runFactoryOrder(
        database,
        { id: "order-no-worktree" },
        { baseRevision: "abc123", claim, worker, worktree: trunk.dir },
        () => ({
          status: "completed",
          reason: "verified",
        }),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "order_not_checked" }));
    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-no-worktree'").get()).toEqual({
      status: "queued",
    });
    database.close();
  });

  test("rejects lifecycle events out of order", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");

    expect(() =>
      appendOrderEvent(
        database,
        "order-1",
        { worker, kind: "completed", status: "completed" },
        undefined,
        trunk.dir,
      ),
    ).toThrow("order order-1 must be working before it can complete");
    database.close();
  });

  test("refuses to complete an order whose commits never reached the trunk", () => {
    const repo = integratedRepo();
    const database = db();
    const landed = order;
    queueOrder(database, landed, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(
      database,
      "order-1",
      commitOffTrunk(repo.dir, "item-statement"),
      worker,
      "feat: land it",
    );
    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
    );

    expect(() =>
      appendOrderEvent(
        database,
        "order-1",
        { worker, kind: "completed", status: "completed" },
        undefined,
        repo.dir,
      ),
    ).toThrow(expect.objectContaining({ code: "order_not_integrated" }));
    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "working" });

    recordOrderCommit(database, "order-1", repo.sha, worker, "feat: on the trunk");
    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
    );
    appendOrderEvent(
      database,
      "order-1",
      { worker, kind: "completed", status: "completed" },
      undefined,
      repo.dir,
    );

    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "completed" });
    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("ships a commit onto the trunk, which then reads as integrated", () => {
    const repo = integratedRepo();
    const home = mkdtempSync(join(tmpdir(), "dim-ship-"));
    const env = scratchEnv(home);
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    const wt = orderWorktree(repo.dir, "ship-slice");
    writeFileSync(join(wt, "ship-slice.txt"), "slice");
    Bun.spawnSync(["git", "-C", wt, "add", "."]);
    Bun.spawnSync(["git", "-C", wt, "commit", "-q", "-m", "feat: ship-slice"]);
    const sha = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], { stdout: "pipe" })
      .stdout.toString()
      .trim();
    recordOrderCommit(database, "order-1", sha, worker, "feat: ship-slice");

    expect(shipOrder(database, "order-1", wt, env)).toEqual({ landed: "fast_forward" });
    expect(Bun.spawnSync(["git", "-C", repo.dir, "merge-base", "--is-ancestor", sha, "HEAD"]).success).toBe(
      true,
    );

    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("a ship is refused for an order that recorded no commit", () => {
    const repo = integratedRepo();
    const home = mkdtempSync(join(tmpdir(), "dim-ship-"));
    const env = scratchEnv(home);
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");

    expect(() => shipOrder(database, "order-1", repo.dir, env)).toThrow(
      expect.objectContaining({ code: "order_not_integrated" }),
    );

    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("counts a check by when it was recorded, not by when it says it ran", () => {
    const repo = integratedRepo();
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", repo.sha, worker, "feat: land it", "2026-09-18T10:03:00.000Z");
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
      worker,
      "2026-09-18T10:04:00.000Z",
    );

    appendOrderEvent(
      database,
      "order-1",
      { worker, kind: "completed", status: "completed" },
      undefined,
      repo.dir,
    );

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
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", repo.sha, worker, "feat: land it");
    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
    );

    expect(() =>
      appendOrderEvent(
        database,
        "order-1",
        { worker, kind: "completed", status: "completed" },
        undefined,
        repo.dir,
      ),
    ).toThrow(/names trunk as its trunk but has no local branch/);
    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("says the worktree is gone rather than that it names no trunk", () => {
    const database = db();
    const gone = join(tmpdir(), `dim-gone-${Date.now()}`);
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", trunk.sha, worker, "feat: land it");
    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
    );

    expect(() =>
      appendOrderEvent(
        database,
        "order-1",
        { worker, kind: "completed", status: "completed" },
        undefined,
        gone,
      ),
    ).toThrow(/is not a git repo that can be read/);
    database.close();
  });

  test("says a commit is missing rather than unmerged when the repo lacks it", () => {
    const repo = integratedRepo();
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(
      database,
      "order-1",
      "0000000000000000000000000000000000000000",
      worker,
      "feat: mistyped",
    );
    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
    );

    expect(() =>
      appendOrderEvent(
        database,
        "order-1",
        { worker, kind: "completed", status: "completed" },
        undefined,
        repo.dir,
      ),
    ).toThrow(/does not have, so nothing there can place them/);
    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("refuses to complete an order that recorded no commit at all", () => {
    const repo = integratedRepo();
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
    );

    expect(() =>
      appendOrderEvent(
        database,
        "order-1",
        { worker, kind: "completed", status: "completed" },
        undefined,
        repo.dir,
      ),
    ).toThrow(expect.objectContaining({ code: "order_not_integrated" }));
    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("refuses to complete where the repo does not name a trunk to reach", () => {
    const repo = repoWithoutTrunk();
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", repo.sha, worker, "feat: land it");
    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
    );

    expect(() =>
      appendOrderEvent(
        database,
        "order-1",
        { worker, kind: "completed", status: "completed" },
        undefined,
        repo.dir,
      ),
    ).toThrow(expect.objectContaining({ code: "order_trunk_unknown" }));
    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "working" });
    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("refuses to complete an order no passing check was recorded for", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 1, result: "2 failed" },
      worker,
      "2026-09-18T10:02:00.000Z",
    );
    recordOrderCommit(database, "order-1", trunk.sha, worker, "feat: land it", "2026-09-18T10:02:30.000Z");

    expect(() =>
      appendOrderEvent(
        database,
        "order-1",
        { worker, kind: "completed", status: "completed" },
        undefined,
        trunk.dir,
      ),
    ).toThrow(expect.objectContaining({ code: "order_not_checked" }));
    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "working" });

    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T10:03:00.000Z",
    );
    appendOrderEvent(
      database,
      "order-1",
      { worker, kind: "completed", status: "completed" },
      undefined,
      trunk.dir,
    );

    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "completed" });
    database.close();
  });

  test("refuses a check that passed before the order's last commit", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T10:02:00.000Z",
    );
    recordOrderCommit(database, "order-1", trunk.sha, worker, "feat: land it", "2026-09-18T10:03:00.000Z");

    expect(() =>
      appendOrderEvent(
        database,
        "order-1",
        { worker, kind: "completed", status: "completed" },
        undefined,
        trunk.dir,
      ),
    ).toThrow(expect.objectContaining({ code: "order_not_checked" }));

    recordOrderCheck(
      database,
      "order-1",
      { command: "bun run verify", exitCode: 0, result: "green" },
      worker,
      "2026-09-18T10:04:00.000Z",
    );
    appendOrderEvent(
      database,
      "order-1",
      { worker, kind: "completed", status: "completed" },
      undefined,
      trunk.dir,
    );

    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "completed" });
    database.close();
  });

  test("hands an unchecked order back to the queue, and it is claimed again", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");

    appendOrderEvent(database, "order-1", { worker, kind: "failed", reason: "the check never passed" });

    expect(database.query("SELECT status, run_id, stop_reason FROM factory_order").get()).toEqual({
      status: "queued",
      run_id: null,
      stop_reason: "the check never passed",
    });
    claimOrder(database, "order-1", claim, worker);
    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "working" });
    database.close();
  });

  test("records a failure and refuses evidence once the order is back in the queue", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    appendOrderEvent(
      database,
      "order-1",
      { worker, kind: "failed", reason: "needs approval" },
      "2026-09-18T10:02:00.000Z",
    );
    expect(() => recordOrderFile(database, "order-1", { path: "src/after-stop.ts" })).toThrow(
      "order order-1 is not claimed",
    );
    expect(() => recordOrderEnvironment(database, "order-1", teardownReport)).toThrow(
      "order order-1 is not claimed",
    );
    expect(database.query("SELECT count(*) AS count FROM factory_order_file").get()).toEqual({ count: 0 });
    expect(database.query("SELECT count(*) AS count FROM factory_order_environment").get()).toEqual({
      count: 0,
    });
    database.close();
  });

  test("preserves a builder error after the builder records a terminal outcome", async () => {
    const database = db();
    queueOrder(database, { ...order, id: "order-4" }, worker);
    await expect(
      runFactoryOrder(
        database,
        { id: "order-4" },
        { baseRevision: "abc123", claim, worker, worktree: trunk.dir },
        (context) => {
          context.appendEvent({ worker, kind: "failed", reason: "builder stopped" });
          throw new Error("builder failed after stopping");
        },
      ),
    ).rejects.toThrow("builder failed after stopping");
    expect(
      database.query("SELECT status, stop_reason FROM factory_order WHERE id = 'order-4'").get(),
    ).toEqual({
      status: "queued",
      stop_reason: "builder stopped",
    });
    expect(database.query("SELECT kind FROM factory_order_event WHERE order_id = 'order-4'").all()).toEqual([
      { kind: "queued" },
      { kind: "claimed" },
      { kind: "failed" },
    ]);
    database.close();
  });

  test("queues an order with no run behind it, then a claim fills one in", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    expect(database.query("SELECT run_id, project, station, status FROM factory_order").get()).toEqual({
      run_id: null,
      project: "cniska/dim-factory",
      station: null,
      status: "queued",
    });
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    expect(database.query("SELECT run_id, station, status FROM factory_order").get()).toEqual({
      run_id: "run-1",
      station: "dim-station-build",
      status: "working",
    });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'factory_lane%'")
        .all(),
    ).toEqual([]);
    expect(database.query("SELECT kind, session_id FROM factory_order_event ORDER BY id DESC").get()).toEqual(
      {
        kind: "claimed",
        session_id: "session-1",
      },
    );
    // The order states no holder of its own: who has it is the worker on its latest moment.
    expect(database.query("SELECT worker FROM factory_order_event ORDER BY id DESC").get()).toEqual({
      worker,
    });
    database.close();
  });

  test("moves a running order to another station and keeps where it came from", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");

    moveOrder(database, "order-1", "dim-station-review", worker, "2026-09-18T10:02:00.000Z");

    expect(database.query("SELECT station, updated_at FROM factory_order").get()).toEqual({
      station: "dim-station-review",
      updated_at: "2026-09-18T10:02:00.000Z",
    });
    expect(database.query("SELECT kind, station FROM factory_order_event ORDER BY id").all()).toEqual([
      { kind: "queued", station: null },
      { kind: "claimed", station: "dim-station-build" },
      { kind: "moved", station: "dim-station-review" },
    ]);
    database.close();
  });

  test("refuses a move before the order started and after it stopped", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");

    expect(() => moveOrder(database, "order-1", "dim-station-review", worker)).toThrow(
      "order order-1 must be working before it can move",
    );
    expect(database.query("SELECT station FROM factory_order").get()).toEqual({ station: null });

    claimOrder(database, "order-1", claim, worker);
    landed(database, "order-1");
    appendOrderEvent(
      database,
      "order-1",
      { worker, kind: "completed", status: "completed" },
      undefined,
      trunk.dir,
    );

    expect(() => moveOrder(database, "order-1", "dim-station-review", worker)).toThrow(/already completed/);
    expect(database.query("SELECT station FROM factory_order").get()).toEqual({
      station: "dim-station-build",
    });
    database.close();
  });

  test("stores normalized evidence and projects terminal status from events", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", trunk.sha, worker, "feat: order", "2026-09-18T10:02:00.000Z");
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
      worker,
      "2026-09-18T10:03:00.000Z",
    );
    const finding = raiseOrderFinding(
      database,
      "order-1",
      { dimension: "tests", summary: "coverage is present" },
      reviewIn(database, "order-1", worker).reviewer,
      "2026-09-18T10:04:00.000Z",
    );
    answerOrderFinding(database, finding, { answer: "fixed" }, worker, "2026-09-18T10:04:00.000Z");
    recordOrderDocument(database, "order-1", "docs/factory.md", worker, "2026-09-18T10:05:00.000Z");
    appendOrderEvent(
      database,
      "order-1",
      {
        worker,
        kind: "completed",
        status: "completed",
        reason: "verified",
        checkId: check,
        findingId: finding,
      },
      "2026-09-18T10:06:00.000Z",
      trunk.dir,
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
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z");
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
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker, "2026-09-18T10:00:30.000Z");
    landed(database, "order-1", "2026-09-18T10:00:45.000Z");
    appendOrderEvent(
      database,
      "order-1",
      { worker, kind: "completed", status: "completed" },
      "2026-09-18T10:01:00.000Z",
      trunk.dir,
    );

    expect(() => appendOrderEvent(database, "order-1", { worker, kind: "claimed" })).toThrow();
    expect(() =>
      appendOrderEvent(database, "order-1", { worker, kind: "moved", station: "review" }),
    ).toThrow();
    expect(database.query("SELECT status, completed_at FROM factory_order").get()).toEqual({
      status: "completed",
      completed_at: "2026-09-18T10:01:00.000Z",
    });
    database.close();
  });

  test("rejects terminal events whose kind and status disagree", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");

    expect(() =>
      appendOrderEvent(database, "order-1", { worker, kind: "completed", status: "queued" }),
    ).toThrow("terminal event kind must match its status");
    expect(() => appendOrderEvent(database, "order-1", { worker, kind: "completed" })).toThrow(
      "terminal event kind must match its status",
    );
    expect(() =>
      appendOrderEvent(database, "order-1", { worker, kind: "moved", status: "completed" }),
    ).toThrow("terminal event status must match its kind");
    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      status: "queued",
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
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    database.run(
      `CREATE TRIGGER reject_order_projection BEFORE UPDATE ON factory_order
       BEGIN SELECT RAISE(ABORT, 'projection rejected'); END`,
    );

    expect(() => claimOrder(database, "order-1", claim, worker, "2026-09-18T10:01:00.000Z")).toThrow();
    expect(database.query("SELECT count(*) AS count FROM factory_order_event").get()).toEqual({ count: 1 });
    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "queued" });
    database.close();
  });

  test("rolls back evidence when its lifecycle event cannot project", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, worker);
    database.run(
      `CREATE TRIGGER reject_order_evidence_projection BEFORE UPDATE ON factory_order
       BEGIN SELECT RAISE(ABORT, 'projection rejected'); END`,
    );

    expect(() => recordOrderCommit(database, "order-1", "abc123", worker, "feat: order")).toThrow(
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
    queueOrder(database, order, worker);
    claimOrder(database, "order-1", claim, worker);
    const round = reviewIn(database, "order-1", worker);
    const raised = raiseOrderFinding(
      database,
      "order-1",
      { dimension: "docs", summary: "missing" },
      round.reviewer,
    );

    expect(() => answerOrderFinding(database, raised, { answer: "refused" }, worker)).toThrow();
    expect(database.query("SELECT answer FROM factory_order_finding WHERE id = ?").get(raised)).toEqual({
      answer: null,
    });
    expect(
      answerOrderFinding(database, raised, { answer: "refused", resolution: "out of scope" }, worker),
    ).toBeGreaterThan(0);
    database.close();
  });

  test("keeps the report through rebuild because no source can recreate it", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-order-"));
    const environment = { HOME: home, DIM_HOME: home };
    const database = openDb(dbPath(environment));
    const hand = workerIn(database);
    queueOrder(database, order, hand, "2026-09-18T10:00:00.000Z");
    claimOrder(database, "order-1", claim, hand, "2026-09-18T10:01:00.000Z");
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
      kind: "queued",
    });
    closeDb(rebuilt);
    rmSync(home, { recursive: true, force: true });
  });

  test("refuses a claim while the floor is stopped, leaving the order queued", () => {
    const database = db();
    queueOrder(database, order, worker);
    pullStop(database, { reason: "the commit gate records nothing" });

    expect(() => claimOrder(database, "order-1", claim, worker)).toThrow(FactoryStopError);
    expect(database.query("SELECT status FROM factory_order").get()).toEqual({ status: "queued" });

    database.close();
  });

  test("takes a claim once the stop is cleared", () => {
    const database = db();
    queueOrder(database, order, worker);
    pullStop(database, { reason: "the commit gate records nothing" });
    clearStop(database);

    claimOrder(database, "order-1", claim, worker);

    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      status: "working",
    });
    database.close();
  });

  test("lets an order already running record and stop while the floor is stopped", () => {
    const database = db();
    queueOrder(database, order, worker);
    claimOrder(database, "order-1", claim, worker);
    pullStop(database, { reason: "the commit gate records nothing" });

    landed(database, "order-1");
    appendOrderEvent(
      database,
      "order-1",
      { worker, kind: "completed", status: "completed" },
      undefined,
      trunk.dir,
    );

    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-1'").get()).toEqual({
      status: "completed",
    });
    database.close();
  });

  test("drops a queued order, leaving dropped as a terminal status with its reason", () => {
    const database = db();
    queueOrder(database, order, worker);

    dropOrder(database, "order-1", "superseded by other work", worker);

    expect(
      database.query("SELECT status, stop_reason FROM factory_order WHERE id = 'order-1'").get(),
    ).toEqual({ status: "dropped", stop_reason: "superseded by other work" });
    expect(isTerminalOrderStatus("dropped")).toBe(true);
    // Terminal, so nothing can be appended against it afterward.
    expect(() => appendOrderEvent(database, "order-1", { worker, kind: "moved", station: "review" })).toThrow(
      "order order-1 is already dropped",
    );
    database.close();
  });

  test("refuses to drop an order while a hand is holding it", () => {
    const database = db();
    queueOrder(database, order, worker);
    claimOrder(database, "order-1", claim, worker);

    expect(() => dropOrder(database, "order-1", "too late", worker)).toThrow(
      expect.objectContaining({ code: "order_held_by_run" }),
    );
    database.close();
  });

  // An order can turn out to have been built already, and the owner's word for that is the
  // same one a queued order gets: it is not going to be worked.
  test("drops an order nobody is holding though it was once claimed", () => {
    const database = db();
    queueOrder(database, order, worker);
    claimOrder(database, "order-1", { ...claim, station: "dim-station-plan" }, worker);
    moveOrder(database, "order-1", "dim-station-build", worker);

    dropOrder(database, "order-1", "already on trunk", worker);

    expect(
      database.query("SELECT status, stop_reason FROM factory_order WHERE id = 'order-1'").get(),
    ).toEqual({ status: "dropped", stop_reason: "already on trunk" });
    database.close();
  });

  // A hand can stop without letting go — killed, crashed, or a session closed — and the run
  // it left on the order would otherwise hold the order for good.
  test("an order whose hand is over is taken again in place", () => {
    const database = db();
    const builder = workerIn(database, "builder");
    queueOrder(database, { ...order, id: "order-stranded" }, worker);
    claimOrder(database, "order-stranded", claim, worker);
    endWorker(database, worker);

    claimOrder(database, "order-stranded", { ...claim, runId: "run-2" }, builder);

    expect(database.query("SELECT run_id FROM factory_order WHERE id = 'order-stranded'").get()).toEqual({
      run_id: "run-2",
    });
    database.close();
  });

  test("an order whose hand is over can be dropped", () => {
    const database = db();
    queueOrder(database, { ...order, id: "order-abandoned" }, worker);
    claimOrder(database, "order-abandoned", claim, worker);
    endWorker(database, worker);

    dropOrder(database, "order-abandoned", "nobody is coming back to it", workerIn(database, "operator"));

    expect(database.query("SELECT status FROM factory_order WHERE id = 'order-abandoned'").get()).toEqual({
      status: "dropped",
    });
    database.close();
  });

  test("amends a queued order's title and description", () => {
    const database = db();
    queueOrder(database, order, worker);

    amendOrder(database, "order-1", { title: "A corrected title" });

    expect(database.query("SELECT title, description FROM factory_order WHERE id = 'order-1'").get()).toEqual(
      { title: "A corrected title", description: null },
    );
    database.close();
  });

  test("refuses to amend an order once it is claimed", () => {
    const database = db();
    queueOrder(database, order, worker);
    claimOrder(database, "order-1", claim, worker);

    expect(() => amendOrder(database, "order-1", { title: "too late" })).toThrow(
      expect.objectContaining({ code: "order_not_queued" }),
    );
    database.close();
  });
});
