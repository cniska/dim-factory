import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { SCHEMA_SQL } from "./db-schema";
import { clearStop, FactoryStopError, pullStop } from "./factory-stop";
import {
  attemptIn,
  confiningCheckSandbox,
  declareCheck,
  integratedRepo,
  located,
  openReviewBy,
  orderWorktree,
  ranCheck,
  reviewIn,
  scratchEnv,
  workerIn,
} from "./fixtures.test-support";
import { rebuild } from "./ingest-sync";
import { approveOrder, returnOrderArtifact } from "./order-approval";
import {
  completeOrderSlice,
  nextOrderSlice,
  recordOrderBuild,
  recordOrderPlan,
  returnedOrderArtifact,
} from "./order-artifacts";
import { openAttempt } from "./order-attempt";
import { currentOrderCommits } from "./order-commits";
import {
  recordOrderCheck,
  recordOrderCommit,
  recordOrderEnvironment,
  recordOrderFile,
  recordOrderRewrite,
} from "./order-evidence";
import { answerOrderFindings, raiseOrderFinding } from "./order-finding";
import { failedHeadCheck } from "./order-head-check";
import { appendOrderEvent, assertChecked } from "./order-ledger";
import { amendOrder, dropOrder, queueOrder, startOrder } from "./order-lifecycle";
import {
  abortStrandedReview,
  closeOrderReview,
  openOrderReview,
  recordOrderReviewArtifact,
} from "./order-review";
import { shipOrder } from "./order-ship";
import { orderState } from "./order-state";
import { isTerminalOrderStatus, orderStatus } from "./order-status";
import { dbPath } from "./paths";
import { findQuery } from "./query-registry";
import { approveFinalBuildAt, approvePlan, approveReviewAt } from "./station-approvals.test-support";
import { reviewRange } from "./station-review";
import { endWorker, mintWorker, newWorkerSession } from "./worker";
import { bootstrapWorker, createWorkerAssignment } from "./worker-assignment";
import type { WorkerHookReport } from "./worker-environment";
import { worktreePath } from "./wt-command";

let worker = "";
let attemptOperator = "";

function db(): Database {
  const database = new Database(":memory:");
  database.run(SCHEMA_SQL);
  worker = workerIn(database);
  attemptOperator = mintWorker(database, {
    role: "operator",
    sessionId: newWorkerSession("test-operator"),
  }).name;
  return database;
}

function runningBuilder(database: Database): string {
  return mintWorker(database, {
    role: "builder",
    pid: process.pid,
    sessionId: newWorkerSession("running-builder"),
  }).name;
}

const trunk = integratedRepo();
afterAll(() => rmSync(trunk.dir, { recursive: true, force: true }));

const order = {
  id: "order-1",
  project: "cniska/dim-factory",
  title: "Record a factory order",
};

function start(database: Database, orderId = "order-1", operator = attemptOperator, at?: string): number {
  return startOrder(database, orderId, operator, at, trunk.dir);
}

function startPlannedBuild(database: Database, orderId = "order-1", operator = attemptOperator): void {
  start(database, orderId, operator);
  approvePlan(database, orderId, operator);
  attemptIn(database, orderId, worker, operator);
}

function landed(database: Database, orderId: string, at?: string): void {
  recordOrderCommit(database, orderId, trunk.sha, worker, "feat: land it", at);
  recordOrderCheck(
    database,
    orderId,
    ranCheck({ command: "bun run verify", exitCode: 0, result: "green" }),
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
  test("review approval requires a recorded Review artifact", () => {
    const database = db();
    const operator = mintWorker(database, {
      role: "operator",
      sessionId: newWorkerSession("review-artifact-gate-operator"),
    });
    const reviewer = mintWorker(database, {
      role: "reviewer",
      sessionId: newWorkerSession("review-artifact-gate-reviewer"),
    });
    const open = (id: string) => {
      queueOrder(database, { ...order, id }, operator.name);
      startPlannedBuild(database, id, operator.name);
      recordOrderCommit(database, id, "head", worker, "feat: built");
      approveFinalBuildAt(database, id, "head", worker, operator.name);
      return openReviewBy(
        database,
        id,
        { reviewer: reviewer.name, baseSha: "head", headSha: "head" },
        operator.name,
      );
    };
    const missing = open("order-review-artifact-missing");
    closeOrderReview(database, missing.id, "closed", reviewer.name);
    expect(() => approveOrder(database, "order-review-artifact-missing", operator.name, undefined)).toThrow(
      expect.objectContaining({ code: "not_next" }),
    );
    const ready = open("order-review-artifact-ready");
    recordOrderReviewArtifact(database, "order-review-artifact-ready", "## Outcome\n\nClean.", reviewer.name);
    closeOrderReview(database, ready.id, "closed", reviewer.name);
    expect(approveOrder(database, "order-review-artifact-ready", operator.name, undefined)).toBe("review");
    database.close();
  });

  test("build approval requires an artifact for the latest commit", () => {
    const database = db();
    const operator = mintWorker(database, {
      role: "operator",
      sessionId: newWorkerSession("build-gate-operator"),
    });
    const builder = mintWorker(database, {
      role: "builder",
      parentWorker: operator.name,
      sessionId: newWorkerSession("build-gate-builder"),
    });
    queueOrder(database, { ...order, id: "order-build-artifact" }, operator.name);
    start(database, "order-build-artifact", operator.name);
    approvePlan(database, "order-build-artifact", operator.name);
    attemptIn(database, "order-build-artifact", builder.name, operator.name);
    recordOrderCommit(database, "order-build-artifact", "old-head", builder.name, "feat: first");
    recordOrderCheck(
      database,
      "order-build-artifact",
      ranCheck({ command: "bun run verify", exitCode: 0 }),
      builder.name,
    );
    recordOrderBuild(
      database,
      "order-build-artifact",
      "The first build is verified.",
      "old-head",
      builder.name,
    );
    completeOrderSlice(
      database,
      "order-build-artifact",
      nextOrderSlice(database, "order-build-artifact")?.id as number,
      builder.name,
    );
    recordOrderCommit(database, "order-build-artifact", "new-head", builder.name, "feat: second");
    recordOrderCheck(
      database,
      "order-build-artifact",
      ranCheck({ command: "bun run verify", exitCode: 0 }),
      builder.name,
    );

    expect(() =>
      approveOrder(database, "order-build-artifact", operator.name, "the build is complete"),
    ).toThrow(expect.objectContaining({ code: "not_next" }));
    expect(orderState(database, "order-build-artifact")).toEqual({ station: "build", next: "run" });
    database.close();
  });

  test("records a plan and leaves the order waiting on its approval", () => {
    const database = db();
    queueOrder(database, { ...order, id: "order-planned" }, worker);
    start(database, "order-planned");

    recordOrderPlan(database, "order-planned", "## outcome\n\nMove the order before building.", worker, [
      { title: "Move the order", outcome: "The order reaches build." },
    ]);
    expect(
      database
        .query(
          `SELECT a.kind, a.body, w.worker FROM factory_order_artifact a
           JOIN factory_order_event w ON w.artifact_id = a.id AND w.kind = 'artifact_written'
           WHERE a.order_id = 'order-planned'`,
        )
        .get(),
    ).toEqual({ kind: "plan", body: "## outcome\n\nMove the order before building.", worker });
    expect(
      database.query("SELECT kind FROM factory_order_event WHERE order_id = 'order-planned'").all(),
    ).toEqual([{ kind: "queued" }, { kind: "started" }, { kind: "artifact_written" }]);
    expect(orderState(database, "order-planned")).toEqual({ station: "plan", next: "approve" });
    database.close();
  });

  test("loads the returned Plan payload through the shared artifact path", () => {
    const database = db();
    const operator = mintWorker(database, {
      role: "operator",
      sessionId: newWorkerSession("returned-plan-operator"),
    }).name;
    queueOrder(database, { ...order, id: "returned-plan" }, operator);
    start(database, "returned-plan", operator);
    recordOrderPlan(database, "returned-plan", "## Outcome\n\nKeep the artifact concise.", worker, [
      { title: "Keep it concise", outcome: "The owner can review the result." },
    ]);

    returnOrderArtifact(database, "returned-plan", operator, "Include the evidence behind the outcome.");

    expect(returnedOrderArtifact(database, "returned-plan", "plan")).toEqual({
      reason: "Include the evidence behind the outcome.",
      artifactId: 1,
      body: "## Outcome\n\nKeep the artifact concise.",
    });
    database.close();
  });

  test("derives the next slice from the approved plan and its completions", () => {
    const database = db();
    const operator = mintWorker(database, {
      role: "operator",
      sessionId: newWorkerSession("slice-operator"),
    }).name;
    const planner = mintWorker(database, {
      role: "planner",
      parentWorker: operator,
      sessionId: newWorkerSession("slice-planner"),
    }).name;
    const builder = mintWorker(database, {
      role: "builder",
      parentWorker: operator,
      sessionId: newWorkerSession("slice-builder"),
    }).name;
    queueOrder(database, { ...order, id: "order-slices" }, operator);
    start(database, "order-slices", operator);
    const planId = recordOrderPlan(database, "order-slices", "## Outcome\n\nBuild both slices.", planner, [
      { title: "First slice", outcome: "The first slice is verified." },
      { title: "Second slice", outcome: "The second slice is verified." },
    ]);
    approveOrder(database, "order-slices", operator, undefined);
    attemptIn(database, "order-slices", builder, operator, "slice-build-run");

    const first = nextOrderSlice(database, "order-slices");
    expect(first).toMatchObject({ ordinal: 1, title: "First slice" });
    if (!first) throw new Error("the approved plan has no first slice");
    completeOrderSlice(database, "order-slices", first.id, builder);
    expect(nextOrderSlice(database, "order-slices")).toMatchObject({ ordinal: 2, title: "Second slice" });
    completeOrderSlice(database, "order-slices", 2, builder);
    expect(nextOrderSlice(database, "order-slices")).toBeNull();
    expect(
      database.query("SELECT slice_id, worker FROM factory_order_slice_completion ORDER BY slice_id").all(),
    ).toEqual([
      { slice_id: 1, worker: builder },
      { slice_id: 2, worker: builder },
    ]);
    expect(
      database
        .query(
          "SELECT outcome, worker, station FROM factory_order_attempt WHERE order_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get("order-slices"),
    ).toEqual({ outcome: "succeeded", worker: builder, station: "build" });
    expect(openAttempt(database, "order-slices")).toBeNull();
    expect(
      database
        .query("SELECT id FROM factory_order_artifact WHERE order_id = ? AND kind = 'plan'")
        .get("order-slices"),
    ).toEqual({
      id: planId,
    });
    database.close();
  });

  test("refuses a Build artifact before the final slice", () => {
    const database = db();
    const operator = mintWorker(database, {
      role: "operator",
      sessionId: newWorkerSession("artifact-operator"),
    }).name;
    const planner = mintWorker(database, {
      role: "planner",
      parentWorker: operator,
      sessionId: newWorkerSession("artifact-planner"),
    }).name;
    const builder = mintWorker(database, {
      role: "builder",
      parentWorker: operator,
      sessionId: newWorkerSession("artifact-builder"),
    }).name;
    queueOrder(database, { ...order, id: "order-early-artifact" }, operator);
    start(database, "order-early-artifact", operator);
    recordOrderPlan(database, "order-early-artifact", "## Outcome\n\nBuild both slices.", planner, [
      { title: "First slice", outcome: "The first slice is verified." },
      { title: "Second slice", outcome: "The second slice is verified." },
    ]);
    approveOrder(database, "order-early-artifact", operator, undefined);
    attemptIn(database, "order-early-artifact", builder, operator, "early-artifact-run");

    expect(() =>
      recordOrderBuild(database, "order-early-artifact", "The first slice is done.", "first", builder),
    ).toThrow(expect.objectContaining({ code: "build_artifact_before_final_slice" }));
    database.close();
  });

  test("keeps each build hand attributed across a failed retry", () => {
    const database = db();
    const operator = mintWorker(database, {
      role: "operator",
      sessionId: newWorkerSession("test-operator"),
    }).name;
    const station = mintWorker(database, {
      role: "reviewer",
      parentWorker: operator,
      sessionId: newWorkerSession("test-station"),
    }).name;
    const builder = mintWorker(database, {
      role: "builder",
      parentWorker: station,
      sessionId: newWorkerSession("test-builder"),
    }).name;
    queueOrder(database, { ...order, id: "order-attempts" }, operator);
    start(database, "order-attempts", operator, "2026-09-22T10:00:00.000Z");
    approvePlan(database, "order-attempts", operator);
    attemptIn(database, "order-attempts", builder, operator, "build-run", "2026-09-22T10:02:00.000Z");
    appendOrderEvent(
      database,
      "order-attempts",
      { kind: "failed", worker: builder, reason: "the check failed" },
      "2026-09-22T10:03:00.000Z",
    );
    attemptIn(database, "order-attempts", builder, operator, "build-retry", "2026-09-22T10:04:00.000Z");

    expect(
      database
        .query(
          `SELECT run_id, worker, operator_worker, station, recorded_at, kind, outcome, reason
           FROM factory_order_attempt WHERE order_id = ? ORDER BY id`,
        )
        .all("order-attempts"),
    ).toEqual([
      {
        run_id: "build-run",
        worker: builder,
        operator_worker: operator,
        station: "build",
        recorded_at: "2026-09-22T10:02:00.000Z",
        kind: "started",
        outcome: "running",
        reason: null,
      },
      {
        run_id: "build-run",
        worker: builder,
        operator_worker: operator,
        station: "build",
        recorded_at: "2026-09-22T10:03:00.000Z",
        kind: "finished",
        outcome: "failed",
        reason: "the check failed",
      },
      {
        run_id: "build-retry",
        worker: builder,
        operator_worker: operator,
        station: "build",
        recorded_at: "2026-09-22T10:04:00.000Z",
        kind: "started",
        outcome: "running",
        reason: null,
      },
    ]);
    database.close();
  });

  test("a review aborts a round its runner left open, so the order can be reviewed again", () => {
    const database = db();
    const runner = workerIn(database, "operator");
    const operator = workerIn(database, "operator");
    queueOrder(database, { ...order, id: "stranded-review" }, runner);
    start(database, "stranded-review", runner, "2026-09-22T12:00:00.000Z");
    const unaccepted = createWorkerAssignment(database, { parentWorker: runner, role: "reviewer" });
    const stranded = openOrderReview(
      database,
      "stranded-review",
      { assignmentId: unaccepted.id, baseSha: "base0000", headSha: "base0000" },
      runner,
      "2026-09-22T12:01:00.000Z",
    );

    abortStrandedReview(database, "stranded-review", operator, "2026-09-22T12:02:00.000Z");

    expect(
      database
        .query<{ outcome: string | null; closed_at: string | null }, [number]>(
          "SELECT outcome, closed_at FROM factory_order_review WHERE id = ?",
        )
        .get(stranded.id),
    ).toEqual({ outcome: "aborted", closed_at: "2026-09-22T12:02:00.000Z" });
    expect(
      database
        .query<
          { kind: string; worker: string | null; review_id: number | null; reason: string | null },
          [string]
        >(
          "SELECT kind, worker, review_id, reason FROM factory_order_event WHERE order_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get("stranded-review"),
    ).toEqual({
      kind: "review_closed",
      worker: operator,
      review_id: stranded.id,
      reason: "its reviewer stopped without finishing",
    });

    const again = createWorkerAssignment(database, { parentWorker: operator, role: "reviewer" });
    expect(
      openOrderReview(
        database,
        "stranded-review",
        { assignmentId: again.id, baseSha: "base0000", headSha: "base0000" },
        operator,
      ).round,
    ).toBe(2);
    database.close();
  });

  function acceptedRound(
    database: Database,
    orderId: string,
    runner: string,
    pid: number | null = process.pid,
  ): { id: number; reviewer: string } {
    queueOrder(database, { ...order, id: orderId }, runner);
    start(database, orderId, runner);
    const assignment = createWorkerAssignment(database, { parentWorker: runner, role: "reviewer" });
    const round = openOrderReview(
      database,
      orderId,
      { assignmentId: assignment.id, baseSha: "base0000", headSha: "base0000" },
      runner,
    );
    const reviewer = bootstrapWorker(database, {
      id: assignment.id,
      token: assignment.token,
      sessionId: newWorkerSession("accepted-reviewer"),
      pid: pid ?? undefined,
    }).name;
    return { id: round.id, reviewer };
  }

  function namedRound(database: Database, orderId: string, runner: string): { id: number; reviewer: string } {
    queueOrder(database, { ...order, id: orderId }, runner);
    start(database, orderId, runner);
    const reviewer = mintWorker(database, {
      role: "reviewer",
      pid: process.pid,
      sessionId: newWorkerSession("named-reviewer"),
    }).name;
    const round = openReviewBy(
      database,
      orderId,
      { reviewer, baseSha: "base0000", headSha: "base0000" },
      runner,
    );
    return { id: round.id, reviewer };
  }

  test.each([
    ["accepted its assignment", acceptedRound],
    ["was named when the round opened", namedRound],
  ])("a review leaves the round of a reviewer that %s and is still running open", (_, openRound) => {
    const database = db();
    const runner = workerIn(database, "operator");
    const operator = workerIn(database, "operator");
    const round = openRound(database, "reviewer-running", runner);
    const events = () =>
      database
        .query<{ n: number }, [string]>("SELECT count(*) AS n FROM factory_order_event WHERE order_id = ?")
        .get("reviewer-running")?.n;
    const before = events();

    abortStrandedReview(database, "reviewer-running", operator);

    expect(
      database
        .query<{ closed_at: string | null }, [number]>(
          "SELECT closed_at FROM factory_order_review WHERE id = ?",
        )
        .get(round.id),
    ).toEqual({ closed_at: null });
    expect(events()).toBe(before);
    database.close();
  });

  test.each([
    ["ran as a process that has exited", Bun.spawnSync(["true"]).pid],
    ["has no recorded pid", null],
  ])("a review aborts the round of a reviewer that %s", (_, pid) => {
    const database = db();
    const runner = workerIn(database, "operator");
    const operator = workerIn(database, "operator");
    const round = acceptedRound(database, "reviewer-gone", runner, pid);

    abortStrandedReview(database, "reviewer-gone", operator);

    expect(
      database
        .query<{ outcome: string | null }, [number]>("SELECT outcome FROM factory_order_review WHERE id = ?")
        .get(round.id),
    ).toEqual({ outcome: "aborted" });
    database.close();
  });

  test("a review aborts the round of a reviewer that has ended, under the operator", () => {
    const database = db();
    const runner = workerIn(database, "operator");
    const operator = workerIn(database, "operator");
    const round = acceptedRound(database, "reviewer-ended", runner);
    endWorker(database, round.reviewer);

    abortStrandedReview(database, "reviewer-ended", operator);

    expect(
      database
        .query<{ outcome: string | null }, [number]>("SELECT outcome FROM factory_order_review WHERE id = ?")
        .get(round.id),
    ).toEqual({ outcome: "aborted" });
    expect(
      database
        .query<{ worker: string }, [number]>(
          "SELECT worker FROM factory_order_event WHERE review_id = ? AND kind = 'review_closed'",
        )
        .get(round.id),
    ).toEqual({ worker: operator });
    database.close();
  });

  test("refuses a second build attempt while the first attempt's worker is running", () => {
    const database = db();
    const builder = workerIn(database, "builder");
    queueOrder(database, { ...order, id: "order-taken" }, worker);
    start(database, "order-taken");
    attemptIn(database, "order-taken", runningBuilder(database), attemptOperator, "run-1");

    expect(() => attemptIn(database, "order-taken", builder, attemptOperator, "run-2")).toThrow(
      expect.objectContaining({ code: "order_held_by_run", message: expect.stringMatching(/under run-1/) }),
    );
    database.close();
  });

  test("rejects lifecycle events out of order", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");

    expect(() => appendOrderEvent(database, "order-1", { worker, kind: "shipped" })).toThrow(
      "order order-1 is queued, so it cannot record shipped",
    );
    database.close();
  });

  test("ships a commit onto the trunk, which makes the order done and removes its worktree", () => {
    const repo = integratedRepo();
    const home = mkdtempSync(join(tmpdir(), "dim-ship-"));
    const env = scratchEnv(home);
    mkdirSync(join(repo.dir, "scripts"));
    writeFileSync(
      join(repo.dir, "scripts", "worktree-teardown.sh"),
      `#!/bin/sh\ntest -d '${env.DIM_HOME}/lock'\n`,
      {
        mode: 0o755,
      },
    );
    Bun.spawnSync(["git", "-C", repo.dir, "add", "scripts/worktree-teardown.sh"]);
    Bun.spawnSync(["git", "-C", repo.dir, "commit", "-q", "-m", "test: require ship lock through teardown"]);
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    startPlannedBuild(database);
    const wt = orderWorktree(repo.dir, "order-1");
    writeFileSync(join(wt, "ship-slice.txt"), "slice");
    Bun.spawnSync(["git", "-C", wt, "add", "."]);
    Bun.spawnSync(["git", "-C", wt, "commit", "-q", "-m", "feat: ship-slice"]);
    const sha = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], { stdout: "pipe" })
      .stdout.toString()
      .trim();
    recordOrderCommit(database, "order-1", sha, worker, "feat: ship-slice");
    approveFinalBuildAt(database, "order-1", sha, worker, attemptOperator);
    approveReviewAt(database, "order-1", sha, attemptOperator);
    expect(shipOrder(database, "order-1", wt, attemptOperator, { env })).toEqual({ landed: "fast_forward" });
    expect(Bun.spawnSync(["git", "-C", repo.dir, "merge-base", "--is-ancestor", sha, "HEAD"]).success).toBe(
      true,
    );
    expect(orderStatus(database, "order-1")).toBe("done");
    expect(
      database
        .query("SELECT worker, commit_sha, evidence FROM factory_order_event WHERE kind = 'shipped'")
        .get(),
    ).toEqual({ worker: attemptOperator, commit_sha: sha, evidence: '{"landed":"fast_forward"}' });
    expect(existsSync(wt)).toBe(false);

    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("a ship is refused for an order that recorded no commit", () => {
    const repo = integratedRepo();
    const home = mkdtempSync(join(tmpdir(), "dim-ship-"));
    const env = scratchEnv(home);
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    startPlannedBuild(database);
    completeOrderSlice(database, "order-1", nextOrderSlice(database, "order-1")?.id as number, worker);

    expect(() => shipOrder(database, "order-1", repo.dir, attemptOperator, { env })).toThrow(
      expect.objectContaining({ code: "not_next" }),
    );

    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  describe("shipping onto a trunk that moved", () => {
    const scenes: string[] = [];
    afterAll(() => {
      for (const dir of scenes) rmSync(dir, { recursive: true, force: true });
    });

    function git(dir: string, args: string[]): string {
      return Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe" })
        .stdout.toString()
        .trim();
    }

    function commit(dir: string, file: string, contents: string, subject: string): string {
      writeFileSync(join(dir, file), contents);
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", subject]);
      return git(dir, ["rev-parse", "HEAD"]);
    }

    function scene(
      trunkMoves: (dir: string) => void,
      {
        check = "true" as string | null,
        env = {} as Record<string, string>,
        unrecordedBetween = false,
        reviewed = true,
      } = {},
    ) {
      const repo = integratedRepo();
      const home = mkdtempSync(join(tmpdir(), "dim-rebase-ship-"));
      scenes.push(repo.dir, home);
      if (check !== null) declareCheck(repo.dir, check);
      commit(repo.dir, "f.txt", "a\nb\nc\nd\ne\nf\ng\n", "feat: add f");
      const database = db();
      queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
      startPlannedBuild(database);
      const wt = orderWorktree(repo.dir, "order-1");
      scenes.push(wt);
      const first = commit(wt, "f.txt", "a\nb\nc\nD\ne\nf\ng\n", "feat: change d");
      if (unrecordedBetween) commit(wt, "h.txt", "h", "feat: add h outside the runner");
      const second = commit(wt, "g.txt", "g", "feat: add g");
      recordOrderCommit(database, "order-1", first, worker, "feat: change d");
      recordOrderCommit(database, "order-1", second, worker, "feat: add g");
      approveFinalBuildAt(database, "order-1", second, worker, attemptOperator);
      if (reviewed) approveReviewAt(database, "order-1", second, attemptOperator);
      trunkMoves(repo.dir);
      const ship = () =>
        shipOrder(database, "order-1", wt, attemptOperator, {
          env: { ...scratchEnv(home), ...env },
          checkSandbox: confiningCheckSandbox(),
        });
      return { repo, wt, database, first, second, trunkTip: git(repo.dir, ["rev-parse", "HEAD"]), ship };
    }

    const unrelatedMove = (dir: string) => {
      commit(dir, "unrelated.txt", "u", "feat: add unrelated");
    };
    const contextMove = (dir: string) => {
      commit(dir, "f.txt", "A\nb\nc\nd\ne\nf\ng\n", "feat: change a");
    };

    test("a clean rebase lands one commit per recorded commit, each recorded as rewritten from its old sha", () => {
      const { repo, database, first, second, ship } = scene(unrelatedMove);

      expect(ship()).toEqual({ landed: "rebased" });

      const current = currentOrderCommits(database, "order-1").map((c) => c.sha);
      expect(current).toHaveLength(2);
      expect(current).not.toContain(first);
      expect(current).not.toContain(second);
      for (const sha of current) {
        expect(
          Bun.spawnSync(["git", "-C", repo.dir, "merge-base", "--is-ancestor", sha, "HEAD"]).success,
        ).toBe(true);
      }
      const rows = findQuery("order")?.run(database, { arg: "order-1" }).rows ?? [];
      const rewritten = rows.filter((row) => row[0] === "event" && row[2] === "commit_rewritten");
      expect(rewritten.map((row) => row[5])).toEqual([
        `${first} -> ${current[0]}`,
        `${second} -> ${current[1]}`,
      ]);
      expect(rows.filter((row) => row[0] === "rewrite").map((row) => row[3])).toEqual(["patch_equal"]);
      expect(
        database.query("SELECT commit_sha, evidence FROM factory_order_event WHERE kind = 'shipped'").all(),
      ).toEqual([{ commit_sha: current[1], evidence: '{"landed":"rebased"}' }]);
    });

    test("a rebase that changed no patch keeps the approved review and ends the order", () => {
      const { database, ship } = scene(unrelatedMove);

      ship();

      expect(orderStatus(database, "order-1")).toBe("done");
      expect(ship).toThrow("order order-1 is done, so it cannot ship");
    });

    test("a rebase that changed a patch lands nothing and returns the order to review for the whole order", () => {
      const { repo, wt, database, trunkTip, ship } = scene(contextMove);

      expect(ship).toThrow(expect.objectContaining({ code: "ship_patch_changed" }));

      expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(trunkTip);
      const current = currentOrderCommits(database, "order-1").map((c) => c.sha);
      expect(git(wt, ["rev-parse", "HEAD"])).toBe(current.at(-1) as string);
      expect(database.query("SELECT patch_equal FROM factory_order_rewrite").all()).toEqual([
        { patch_equal: 0 },
      ]);
      expect(orderState(database, "order-1")).toEqual({ station: "review", next: "run" });
      expect(reviewRange(database, "order-1", wt)).toEqual({
        base: trunkTip,
        head: current.at(-1) as string,
      });
    });

    test("a red check at the rebased head lands nothing, keeps the rebase and sends the order to build", () => {
      const { repo, wt, database, first, second, trunkTip, ship } = scene(unrelatedMove, { check: "exit 3" });

      expect(ship).toThrow(expect.objectContaining({ code: "ship_check_failed" }));

      expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(trunkTip);
      const current = currentOrderCommits(database, "order-1").map((c) => c.sha);
      expect(current).toHaveLength(2);
      expect(current).not.toContain(first);
      expect(current).not.toContain(second);
      expect(git(wt, ["rev-parse", "HEAD"])).toBe(current.at(-1) as string);
      expect(git(wt, ["merge-base", "HEAD", "main"])).toBe(trunkTip);
      expect(
        database
          .query("SELECT exit_code FROM factory_order_check WHERE order_id = 'order-1' ORDER BY id")
          .all(),
      ).toEqual([{ exit_code: 0 }, { exit_code: 3 }]);
      expect(failedHeadCheck(database, "order-1")).toMatchObject({ exitCode: 3 });
      expect(orderState(database, "order-1")).toEqual({ station: "build", next: "run" });
    });

    test("a passing check recorded after the rebased head clears the red one", () => {
      const { database, ship } = scene(unrelatedMove, { check: "exit 3" });
      expect(ship).toThrow(expect.objectContaining({ code: "ship_check_failed" }));

      recordOrderCheck(database, "order-1", ranCheck({ command: "true", exitCode: 0 }), attemptOperator);

      expect(failedHeadCheck(database, "order-1")).toBeNull();
      expect(orderState(database, "order-1")).toEqual({ station: null, next: "ship" });
    });

    test("a commit the branch carried but the order never recorded is replayed without becoming the order's", () => {
      const { repo, database, ship } = scene(unrelatedMove, { unrecordedBetween: true });

      expect(ship()).toEqual({ landed: "rebased" });

      const current = currentOrderCommits(database, "order-1");
      expect(current.map((c) => c.subject)).toEqual(["feat: change d", "feat: add g"]);
      expect(git(repo.dir, ["log", "--format=%s", "-3"]).split("\n")).toEqual([
        "feat: add g",
        "feat: add h outside the runner",
        "feat: change d",
      ]);
    });

    test("a review after a rebase that kept every patch reads on from the head it last read", () => {
      const { wt, database, first, second, trunkTip } = scene(unrelatedMove, { reviewed: false });
      const read = reviewIn(database, "order-1", attemptOperator, undefined, second);
      closeOrderReview(database, read.review, "closed", read.reviewer);
      const oldBase = git(wt, ["merge-base", "HEAD", "main"]);
      git(wt, ["rebase", "-q", "main"]);
      const head = git(wt, ["rev-parse", "HEAD"]);
      recordOrderRewrite(
        database,
        "order-1",
        {
          worktree: wt,
          oldBase,
          newBase: trunkTip,
          oldHead: second,
          newHead: head,
          commits: [
            { from: first, to: git(wt, ["rev-parse", "HEAD~1"]) },
            { from: second, to: head },
          ],
          patchEqual: true,
        },
        ranCheck({ command: "bun run verify", exitCode: 0 }),
        attemptOperator,
      );

      expect(reviewRange(database, "order-1", wt)).toEqual({ base: head, head });
    });

    test("a review after a rebase that replayed commits past the head it last read reads the whole order", () => {
      const { wt, database, first, second, trunkTip } = scene(unrelatedMove, { reviewed: false });
      const read = reviewIn(database, "order-1", attemptOperator, undefined, first);
      closeOrderReview(database, read.review, "closed", read.reviewer);
      const oldBase = git(wt, ["merge-base", "HEAD", "main"]);
      git(wt, ["rebase", "-q", "main"]);
      const head = git(wt, ["rev-parse", "HEAD"]);
      recordOrderRewrite(
        database,
        "order-1",
        {
          worktree: wt,
          oldBase,
          newBase: trunkTip,
          oldHead: second,
          newHead: head,
          commits: [
            { from: first, to: git(wt, ["rev-parse", "HEAD~1"]) },
            { from: second, to: head },
          ],
          patchEqual: true,
        },
        ranCheck({ command: "bun run verify", exitCode: 0 }),
        attemptOperator,
      );

      expect(reviewRange(database, "order-1", wt)).toEqual({ base: trunkTip, head });
    });

    test("an aborted round read nothing, so the next round reads the whole order", () => {
      const { wt, database, first, second } = scene(unrelatedMove, { reviewed: false });
      const read = reviewIn(database, "order-1", attemptOperator, undefined, second);
      closeOrderReview(database, read.review, "aborted", read.reviewer);

      expect(reviewRange(database, "order-1", wt)).toEqual({
        base: git(wt, ["rev-parse", `${first}^`]),
        head: second,
      });
    });

    test("a review whose last head the order no longer carries, with no rebase to explain it, is refused", () => {
      const { wt, database } = scene(unrelatedMove);
      const read = reviewIn(
        database,
        "order-1",
        attemptOperator,
        undefined,
        "0000000000000000000000000000000000000000",
      );
      closeOrderReview(database, read.review, "closed", read.reviewer);

      expect(() => reviewRange(database, "order-1", wt)).toThrow(/no longer carries/);
    });

    test("a repository that declares no check cannot have its rebased branch landed", () => {
      const { repo, wt, second, trunkTip, ship } = scene(unrelatedMove, { check: null });

      expect(ship).toThrow(expect.objectContaining({ code: "ship_check_failed" }));

      expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(trunkTip);
      expect(git(wt, ["rev-parse", "HEAD"])).toBe(second);
    });

    test("the re-check runs without the operator's factory identity", () => {
      const { ship } = scene(unrelatedMove, {
        check: 'test -z "$DIM_WORKER_NAME"',
        env: { DIM_WORKER_NAME: "the-operator" },
      });

      expect(ship()).toEqual({ landed: "rebased" });
    });

    test("the re-check and the rewrite are recorded under the operator", () => {
      const { database, ship } = scene(unrelatedMove);

      ship();

      const current = currentOrderCommits(database, "order-1").map((c) => c.sha);
      expect(database.query("SELECT worker FROM factory_order_rewrite").all()).toEqual([
        { worker: attemptOperator },
      ]);
      expect(
        database
          .query(
            "SELECT worker FROM factory_order_event WHERE kind IN ('check_finished', 'commit_rewritten') ORDER BY id",
          )
          .all(),
      ).toEqual([
        { worker },
        { worker: attemptOperator },
        { worker: attemptOperator },
        { worker: attemptOperator },
      ]);
      const rows = findQuery("order")?.run(database, { arg: "order-1" }).rows ?? [];
      expect(rows.filter((row) => row[0] === "commit").map((row) => row[2])).toEqual([
        "commit_created",
        "commit_created",
        "commit_rewritten",
        "commit_rewritten",
      ]);
      const board = findQuery("factory")?.run(database, { arg: "order-1" });
      const column = board?.columns.indexOf("commit") ?? -1;
      expect(String(board?.rows[0]?.[column])).toStartWith(current[1] as string);
    });

    test("an approved review follows a chain of rewrites only while every one kept its patches", () => {
      const database = db();
      queueOrder(database, order, worker);
      startPlannedBuild(database);
      recordOrderCommit(database, "order-1", "a0", worker, "feat: a");
      approveFinalBuildAt(database, "order-1", "a0", worker, attemptOperator);
      approveReviewAt(database, "order-1", "a0", attemptOperator);
      const check = ranCheck({ command: "bun run verify", exitCode: 0 });
      const rewrite = (from: string, to: string, patchEqual: boolean) =>
        recordOrderRewrite(
          database,
          "order-1",
          {
            worktree: trunk.dir,
            oldBase: `base-${from}`,
            newBase: `base-${to}`,
            oldHead: from,
            newHead: to,
            commits: [{ from, to }],
            patchEqual,
          },
          check,
          attemptOperator,
        );

      rewrite("a0", "a1", true);
      rewrite("a1", "a2", true);
      expect(orderState(database, "order-1")).toEqual({ station: null, next: "ship" });

      rewrite("a2", "a3", false);
      rewrite("a3", "a4", true);
      expect(orderState(database, "order-1")).toEqual({ station: "review", next: "run" });
    });
  });

  test("counts a check by when it was recorded, not by when it says it ran", () => {
    const repo = integratedRepo();
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    start(database, "order-1", attemptOperator, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", repo.sha, worker, "feat: land it", "2026-09-18T10:03:00.000Z");
    recordOrderCheck(
      database,
      "order-1",
      {
        command: "bun run verify",
        exitCode: 0,
        result: "green",
        startedAt: "2026-09-18T10:01:30.000Z",
        finishedAt: "2026-09-18T10:02:00.000Z",
      },
      worker,
      "2026-09-18T10:04:00.000Z",
    );

    expect(() => assertChecked(database, "order-1")).not.toThrow();
    database.close();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("refuses an order no passing check was recorded for", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    start(database, "order-1", attemptOperator, "2026-09-18T10:01:00.000Z");
    recordOrderCheck(
      database,
      "order-1",
      ranCheck({ command: "bun run verify", exitCode: 1, result: "2 failed" }),
      worker,
      "2026-09-18T10:02:00.000Z",
    );
    recordOrderCommit(database, "order-1", trunk.sha, worker, "feat: land it", "2026-09-18T10:02:30.000Z");

    expect(() => assertChecked(database, "order-1")).toThrow(
      expect.objectContaining({ code: "order_not_checked" }),
    );

    recordOrderCheck(
      database,
      "order-1",
      ranCheck({ command: "bun run verify", exitCode: 0, result: "green" }),
      worker,
      "2026-09-18T10:03:00.000Z",
    );
    expect(() => assertChecked(database, "order-1")).not.toThrow();
    database.close();
  });

  test("refuses a check that passed before the order's last commit", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    start(database, "order-1", attemptOperator, "2026-09-18T10:01:00.000Z");
    recordOrderCheck(
      database,
      "order-1",
      ranCheck({ command: "bun run verify", exitCode: 0, result: "green" }),
      worker,
      "2026-09-18T10:02:00.000Z",
    );
    recordOrderCommit(database, "order-1", trunk.sha, worker, "feat: land it", "2026-09-18T10:03:00.000Z");

    expect(() => assertChecked(database, "order-1")).toThrow(
      expect.objectContaining({ code: "order_not_checked" }),
    );

    recordOrderCheck(
      database,
      "order-1",
      ranCheck({ command: "bun run verify", exitCode: 0, result: "green" }),
      worker,
      "2026-09-18T10:04:00.000Z",
    );
    expect(() => assertChecked(database, "order-1")).not.toThrow();
    database.close();
  });

  test("a failure leaves the order started with its next act unchanged, and another attempt can start", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    startPlannedBuild(database);
    const before = orderState(database, "order-1");

    appendOrderEvent(database, "order-1", { worker, kind: "failed", reason: "the check never passed" });

    expect(orderStatus(database, "order-1")).toBe("active");
    expect(orderState(database, "order-1")).toEqual(before);
    expect(
      database.query("SELECT worker, outcome FROM factory_order_attempt WHERE kind = 'finished'").all(),
    ).toEqual([{ worker, outcome: "failed" }]);
    attemptIn(database, "order-1", worker, attemptOperator, "run-2");
    expect(openAttempt(database, "order-1")).toEqual({
      runId: "run-2",
      worker,
      role: "builder",
      station: "build",
    });
    database.close();
  });

  test("refuses evidence for an order that has not started", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    expect(() =>
      recordOrderFile(database, "order-1", { path: "src/after-stop.ts", added: null, removed: null }, worker),
    ).toThrow("order order-1 is not started");
    expect(() => recordOrderEnvironment(database, "order-1", teardownReport)).toThrow(
      "order order-1 is not started",
    );
    expect(database.query("SELECT count(*) AS count FROM factory_order_file").get()).toEqual({ count: 0 });
    expect(database.query("SELECT count(*) AS count FROM factory_order_environment").get()).toEqual({
      count: 0,
    });
    database.close();
  });

  test("queues an order, then starting it records the operator who started it", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    expect(database.query("SELECT project FROM factory_order").get()).toEqual({
      project: "cniska/dim-factory",
    });
    expect(orderStatus(database, "order-1")).toBe("queued");
    start(database, "order-1", attemptOperator, "2026-09-18T10:01:00.000Z");
    expect(orderStatus(database, "order-1")).toBe("active");
    expect(database.query("SELECT updated_at FROM factory_order").get()).toEqual({
      updated_at: "2026-09-18T10:01:00.000Z",
    });
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'factory_lane%'")
        .all(),
    ).toEqual([]);
    expect(database.query("SELECT kind, worker FROM factory_order_event ORDER BY id").all()).toEqual([
      { kind: "queued", worker },
      { kind: "started", worker: attemptOperator },
    ]);
    expect(orderState(database, "order-1")).toEqual({ station: "plan", next: "run" });
    database.close();
  });

  test("refuses to start an order twice or after it shipped", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    start(database, "order-1");

    expect(() => start(database, "order-1")).toThrow(expect.objectContaining({ code: "order_not_queued" }));

    appendOrderEvent(database, "order-1", { worker: attemptOperator, kind: "shipped" });

    expect(() => start(database, "order-1")).toThrow(expect.objectContaining({ code: "order_not_queued" }));
    expect(orderStatus(database, "order-1")).toBe("done");
    database.close();
  });

  test("a file changed by two slices is one row carrying both slices' lines", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    start(database, "order-1", attemptOperator, "2026-09-18T10:01:00.000Z");
    recordOrderFile(
      database,
      "order-1",
      { path: "src/factory-order.ts", added: 40, removed: 9 },
      worker,
      "2026-09-18T10:02:00.000Z",
    );
    recordOrderFile(
      database,
      "order-1",
      { path: "src/factory-order.ts", added: 5, removed: 2 },
      worker,
      "2026-09-18T10:03:00.000Z",
    );
    recordOrderFile(
      database,
      "order-1",
      { path: "assets/logo.png", added: null, removed: null },
      worker,
      "2026-09-18T10:02:00.000Z",
    );
    recordOrderFile(
      database,
      "order-1",
      { path: "assets/logo.png", added: 3, removed: 1 },
      worker,
      "2026-09-18T10:03:00.000Z",
    );

    expect(
      database.query("SELECT path, added, removed, recorded_at FROM factory_order_file ORDER BY path").all(),
    ).toEqual([
      { path: "assets/logo.png", added: null, removed: null, recorded_at: "2026-09-18T10:03:00.000Z" },
      { path: "src/factory-order.ts", added: 45, removed: 11, recorded_at: "2026-09-18T10:03:00.000Z" },
    ]);
    database.close();
  });

  test("stores normalized evidence and reads the status from events", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    start(database, "order-1", attemptOperator, "2026-09-18T10:01:00.000Z");
    recordOrderCommit(database, "order-1", trunk.sha, worker, "feat: order", "2026-09-18T10:02:00.000Z");
    recordOrderFile(
      database,
      "order-1",
      { path: "src/factory-order.ts", added: 40, removed: 9 },
      worker,
      "2026-09-18T10:02:30.000Z",
    );
    const check = recordOrderCheck(
      database,
      "order-1",
      ranCheck({ command: "bun run verify", exitCode: 0, result: "426 tests" }),
      worker,
      "2026-09-18T10:03:00.000Z",
    );
    const finding = raiseOrderFinding(
      database,
      "order-1",
      located({ dimension: "tests", failure: "coverage is present" }),
      reviewIn(database, "order-1", worker).reviewer,
      "2026-09-18T10:04:00.000Z",
    );
    answerOrderFindings(
      database,
      "order-1",
      "run-1",
      [{ finding, answer: "fixed", resolution: null }],
      worker,
      "2026-09-18T10:04:00.000Z",
    );
    appendOrderEvent(
      database,
      "order-1",
      { worker, kind: "shipped", reason: "verified", checkId: check, findingId: finding },
      "2026-09-18T10:06:00.000Z",
    );
    expect(orderStatus(database, "order-1")).toBe("done");
    expect(database.query("SELECT updated_at FROM factory_order").get()).toEqual({
      updated_at: "2026-09-18T10:06:00.000Z",
    });
    expect(database.query("SELECT sha FROM factory_order_commit").get()).toEqual({ sha: trunk.sha });
    expect(database.query("SELECT path FROM factory_order_file").get()).toEqual({
      path: "src/factory-order.ts",
    });
    expect(database.query("SELECT command, exit_code FROM factory_order_check").get()).toEqual({
      command: "bun run verify",
      exit_code: 0,
    });
    expect(
      database
        .query(
          "SELECT f.dimension, a.answer FROM factory_order_finding f JOIN factory_order_finding_answer a ON a.finding_id = f.id",
        )
        .get(),
    ).toEqual({ dimension: "tests", answer: "fixed" });
    expect(
      database
        .query<{ event: string; fields: string }, []>(
          "SELECT event, fields FROM trace_event WHERE order_id = 'order-1' ORDER BY id DESC LIMIT 1",
        )
        .get(),
    ).toEqual({
      event: "order.lifecycle",
      fields: JSON.stringify({ kind: "shipped", status: "done", reason: "verified", artifact: null }),
    });
    database.close();
  });

  test("attaches a worktree's setup and teardown reports to the order", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    start(database, "order-1", attemptOperator, "2026-09-18T10:01:00.000Z");
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
    start(database, "order-1", attemptOperator, "2026-09-18T10:00:30.000Z");
    appendOrderEvent(database, "order-1", { worker, kind: "shipped" }, "2026-09-18T10:01:00.000Z");

    expect(() => appendOrderEvent(database, "order-1", { worker, kind: "started" })).toThrow(
      "order order-1 is already done",
    );
    expect(() => appendOrderEvent(database, "order-1", { worker, kind: "commit_created" })).toThrow(
      "order order-1 is already done",
    );
    expect(orderStatus(database, "order-1")).toBe("done");
    database.close();
  });

  test("rolls back an event when projecting it fails", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    database.run(
      `CREATE TRIGGER reject_order_projection BEFORE UPDATE ON factory_order
       BEGIN SELECT RAISE(ABORT, 'projection rejected'); END`,
    );

    expect(() => start(database, "order-1", attemptOperator, "2026-09-18T10:01:00.000Z")).toThrow(
      "projection rejected",
    );
    expect(database.query("SELECT count(*) AS count FROM factory_order_event").get()).toEqual({ count: 1 });
    expect(orderStatus(database, "order-1")).toBe("queued");
    database.close();
  });

  test("rolls back evidence when its lifecycle event cannot project", () => {
    const database = db();
    queueOrder(database, order, worker, "2026-09-18T10:00:00.000Z");
    start(database);
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

  test("keeps the report through rebuild because no source can recreate it", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-order-"));
    const environment = { HOME: home, DIM_HOME: home };
    const database = openDb(dbPath(environment));
    const hand = workerIn(database);
    attemptOperator = mintWorker(database, {
      role: "operator",
      sessionId: newWorkerSession("rebuild-operator"),
    }).name;
    queueOrder(database, order, hand, "2026-09-18T10:00:00.000Z");
    start(database, "order-1", attemptOperator, "2026-09-18T10:01:00.000Z");
    recordOrderEnvironment(database, "order-1", teardownReport, "2026-09-18T10:02:00.000Z");
    closeDb(database);
    const rebuilt = openDb(dbPath(environment), { forRebuild: true });
    rebuild(rebuilt, environment);
    expect(orderStatus(rebuilt, "order-1")).toBe("active");
    expect(
      rebuilt.query("SELECT phase, signal FROM factory_order_environment WHERE order_id = 'order-1'").get(),
    ).toEqual({ phase: "teardown", signal: "SIGKILL" });
    expect(rebuilt.query("SELECT kind FROM factory_order_event WHERE order_id = 'order-1'").get()).toEqual({
      kind: "queued",
    });
    closeDb(rebuilt);
    rmSync(home, { recursive: true, force: true });
  });

  test("refuses to start an order while the floor is stopped, leaving it queued", () => {
    const database = db();
    queueOrder(database, order, worker);
    pullStop(database, { reason: "the commit gate records nothing" });

    expect(() => start(database)).toThrow(FactoryStopError);
    expect(orderStatus(database, "order-1")).toBe("queued");

    database.close();
  });

  test("starts an order once the stop is cleared", () => {
    const database = db();
    queueOrder(database, order, worker);
    pullStop(database, { reason: "the commit gate records nothing" });
    clearStop(database);

    start(database);

    expect(orderStatus(database, "order-1")).toBe("active");
    database.close();
  });

  test("lets an order already running record and ship while the floor is stopped", () => {
    const database = db();
    queueOrder(database, order, worker);
    start(database);
    pullStop(database, { reason: "the commit gate records nothing" });

    landed(database, "order-1");
    appendOrderEvent(database, "order-1", { worker: attemptOperator, kind: "shipped" });

    expect(orderStatus(database, "order-1")).toBe("done");
    database.close();
  });

  test("drops a queued order, leaving dropped as a terminal status with its reason", () => {
    const database = db();
    queueOrder(database, order, worker);

    dropOrder(database, "order-1", "superseded by other work", worker);

    expect(orderStatus(database, "order-1")).toBe("dropped");
    expect(database.query("SELECT reason FROM factory_order_event WHERE kind = 'dropped'").get()).toEqual({
      reason: "superseded by other work",
    });
    expect(isTerminalOrderStatus("dropped")).toBe(true);
    expect(() => appendOrderEvent(database, "order-1", { worker, kind: "started" })).toThrow(
      "order order-1 is already dropped",
    );
    database.close();
  });

  test("refuses to drop an order while its build attempt is running", () => {
    const database = db();
    queueOrder(database, order, worker);
    start(database);
    attemptIn(database, "order-1", runningBuilder(database), attemptOperator);

    expect(() => dropOrder(database, "order-1", "too late", worker)).toThrow(
      expect.objectContaining({ code: "order_held_by_run" }),
    );
    database.close();
  });

  test("drops a started order with no running attempt and keeps its worktree", () => {
    const database = db();
    queueOrder(database, order, worker);
    start(database);
    attemptIn(database, "order-1", worker, attemptOperator);

    dropOrder(database, "order-1", "already on trunk", worker);

    expect(orderStatus(database, "order-1")).toBe("dropped");
    expect(existsSync(worktreePath(trunk.dir, "order-1"))).toBe(true);
    database.close();
  });

  test("a new build attempt starts once the previous attempt's worker is over", () => {
    const database = db();
    const builder = workerIn(database, "builder");
    queueOrder(database, { ...order, id: "order-stranded" }, worker);
    start(database, "order-stranded");
    const holder = runningBuilder(database);
    attemptIn(database, "order-stranded", holder, attemptOperator, "run-1");
    endWorker(database, holder);

    attemptIn(database, "order-stranded", builder, attemptOperator, "run-2");

    expect(openAttempt(database, "order-stranded")).toEqual({
      runId: "run-2",
      worker: builder,
      role: "builder",
      station: "build",
    });
    database.close();
  });

  test("an order whose attempt's worker is over can be dropped", () => {
    const database = db();
    queueOrder(database, { ...order, id: "order-abandoned" }, worker);
    start(database, "order-abandoned");
    const holder = runningBuilder(database);
    attemptIn(database, "order-abandoned", holder, attemptOperator);
    endWorker(database, holder);

    dropOrder(database, "order-abandoned", "nobody is coming back to it", workerIn(database, "operator"));

    expect(orderStatus(database, "order-abandoned")).toBe("dropped");
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

  test("refuses to amend an order once it is started", () => {
    const database = db();
    queueOrder(database, order, worker);
    start(database);

    expect(() => amendOrder(database, "order-1", { title: "too late" })).toThrow(
      expect.objectContaining({ code: "order_not_queued" }),
    );
    database.close();
  });
});
