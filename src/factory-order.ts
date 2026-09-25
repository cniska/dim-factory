import type { Database } from "bun:sqlite";
import type { AttemptOutcome, EvidenceReference, OrderEventKind } from "./factory-events";
import { FactoryStopError, liveStop } from "./factory-stop";
import { workerIsOver } from "./factory-worker";
import { withLock } from "./lock";
import type { OrderLine } from "./order-line";
import type { Env } from "./paths";
import type { PlanSlice } from "./plan-artifact";
import { type ShipOutcome, shipToTrunk } from "./ship";
import { writeTrace } from "./trace-store";
import { reachesTrunk } from "./trunk";
import type { WorkerHookReport } from "./worker-environment";
import { createWorktree } from "./wt-command";

/** What state the order is in. A claim takes it straight to `working`: an order
 *  already exists before a worker sees it, so taking one and starting it are one act.
 *  `dropped` is the owner's decision that the order will not be built, which is a
 *  different fact from an attempt that failed and goes back to `queued`. */
export const ORDER_STATUSES = ["queued", "working", "completed", "dropped"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const APPROVAL_HOLD = "approval";

/** Binds at creation only: a table already on disk keeps the CHECK it was born with. */
export const ORDER_STATUSES_SQL = ORDER_STATUSES.map((status) => `'${status}'`).join(",");

export type { AttemptOutcome, EvidenceReference, OrderEventKind } from "./factory-events";
export { ATTEMPT_OUTCOMES, ORDER_EVENT_KINDS } from "./factory-events";

export const ORDER_PRIORITIES = ["urgent", "high", "medium", "low", "unset"] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

/** What is written down before anyone takes it. The branch and the worktree are
 *  derived from the id, so neither is stored. */
export type Order = {
  id: string;
  project: string;
  title: string;
  line?: OrderLine;
  description?: string;
  priority?: OrderPriority;
  hold?: string;
  provenance?: EvidenceReference;
};

/** What the operator knows only once it has a worker to hand the order to. Who that
 *  worker is comes from the environment it was started in, never from the claim. */
export type OrderClaim = {
  runId: string;
  sessionId?: string;
  station?: string;
  operatorWorker: string;
  providerSessionId?: string;
  harness?: string;
  model?: string;
  tier?: string;
};

export type OrderEvent = {
  kind: OrderEventKind;
  /** Absent only when the runner failed before a station worker bootstrapped. */
  worker?: string;
  sessionId?: string;
  station?: string;
  commitSha?: string;
  checkId?: number;
  reviewId?: number;
  findingId?: number;
  planId?: number;
  buildId?: number;
  holdType?: string;
  status?: OrderStatus;
  reason?: string;
  evidence?: EvidenceReference;
  ts?: string;
};

export type OrderNotDoneCode =
  | "order_not_checked"
  | "order_not_integrated"
  | "order_trunk_unknown"
  | "order_not_queued"
  | "order_held_by_run"
  | "order_not_building"
  | "order_not_planning"
  | "build_not_approved"
  | "build_not_final"
  | "build_artifact_before_final_slice"
  | "build_artifact_missing"
  | "build_revision_head_mismatch"
  | "artifact_revision_required"
  | "review_not_approved";

/** Carries a code because a caller deciding which condition failed must not match on prose. */
export class OrderNotDone extends Error {
  constructor(
    readonly code: OrderNotDoneCode,
    message: string,
  ) {
    super(message);
  }
}

export class PlanApprovalRefused extends Error {
  constructor(
    readonly code: "worker_not_operator" | "plan_missing" | "plan_already_approved",
    message: string,
  ) {
    super(message);
  }
}

export class BuildApprovalRefused extends Error {
  constructor(
    readonly code:
      | "worker_not_operator"
      | "commit_missing"
      | "build_not_checked"
      | "build_not_final"
      | "build_artifact_missing"
      | "build_already_approved",
    message: string,
  ) {
    super(message);
  }
}

export class ReviewApprovalRefused extends Error {
  constructor(
    readonly code:
      | "worker_not_operator"
      | "review_missing"
      | "review_not_closed"
      | "review_aborted"
      | "review_artifact_missing"
      | "findings_present"
      | "review_already_approved",
    message: string,
  ) {
    super(message);
  }
}

const now = (): string => new Date().toISOString();
/** `completed` and `dropped` end an order. Work that stopped without landing goes back to
 *  `queued`, because it is work nobody is holding; a drop is the owner deciding not to
 *  build it at all, which is not an attempt and does not go back. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ["completed", "dropped"];
const terminalStatuses = new Set<OrderStatus>(TERMINAL_ORDER_STATUSES);

/** A refusal is read by whoever typed the command, so it names the act and not the event kind. */
const VERB_FOR_KIND: Record<string, string> = { completed: "complete", moved: "move" };

/** A claim copies an order's description into the record, so amending or dropping the
 *  words after that would leave a worker building to one statement and the queue
 *  showing another. */
function assertOrderQueued(db: Database, orderId: string, act: string): void {
  const order = db.query("SELECT status FROM factory_order WHERE id = ?").get(orderId) as {
    status: OrderStatus;
  } | null;
  if (!order) throw new Error(`order not found: ${orderId}`);
  if (order.status !== "queued") {
    throw new OrderNotDone(
      "order_not_queued",
      `order ${orderId} is ${order.status} and only a queued order can be ${act}`,
    );
  }
}

/**
 * The hand on an order right now, or nothing. The order carries the run, and the worker that
 * claimed it says whether anyone is still behind that run: a hand can stop without letting
 * go — killed, crashed, a session closed — and an order held by a run nobody is running is
 * an order nobody can take and nobody can drop.
 */
function liveHolder(db: Database, orderId: string): { worker: string; runId: string } | null {
  const order = db.query("SELECT run_id FROM factory_order WHERE id = ?").get(orderId) as {
    run_id: string | null;
  } | null;
  if (!order?.run_id) return null;
  const claimed = db
    .query<{ worker: string }, [string]>(
      `SELECT worker FROM factory_order_event WHERE order_id = ? AND kind = 'claimed'
       ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get(orderId);
  if (!claimed || workerIsOver(db, claimed.worker)) return null;
  return { worker: claimed.worker, runId: order.run_id };
}

/**
 * A drop says the order will not be built, which stays true of an order that was taken and
 * handed on: an order can turn out to have been built already, or to have been the wrong
 * thing to ask for, and the owner's word for that is the same one either way. The one thing
 * it cannot be said over is a hand still on the work, which the drop would take from it.
 */
function assertDroppable(db: Database, orderId: string): void {
  const holder = liveHolder(db, orderId);
  if (holder) {
    throw new OrderNotDone(
      "order_held_by_run",
      `order ${orderId} is being worked by ${holder.worker} under ${holder.runId} and a drop would take ` +
        "it from that hand: stop the run, or move the order on, before dropping it",
    );
  }
}

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return terminalStatuses.has(status);
}

function eventValues(orderId: string, event: OrderEvent, ts: string): (string | number | null)[] {
  return [
    orderId,
    ts,
    event.kind,
    event.worker ?? null,
    event.sessionId ?? null,
    event.station ?? null,
    event.commitSha ?? null,
    event.checkId ?? null,
    event.reviewId ?? null,
    event.findingId ?? null,
    event.planId ?? null,
    event.buildId ?? null,
    event.holdType ?? null,
    event.status ?? null,
    event.reason ?? null,
    JSON.stringify(event.evidence ?? {}),
  ];
}

function recordAttemptFinish(
  db: Database,
  orderId: string,
  runId: string | null,
  worker: string | undefined,
  station: string | null,
  outcome: Exclude<AttemptOutcome, "running">,
  reason: string | undefined,
  at: string,
): void {
  if (!runId || !worker) return;
  const started = db
    .query<
      {
        operator_worker: string | null;
        session_id: string | null;
        provider_session_id: string | null;
        harness: string | null;
        model: string | null;
        tier: string | null;
        started_at: string | null;
      },
      [string, string]
    >(
      `SELECT operator_worker, session_id, provider_session_id, harness, model, tier, started_at
       FROM factory_order_attempt
       WHERE order_id = ? AND run_id = ? AND kind = 'started'
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(orderId, runId);
  db.run(
    `INSERT INTO factory_order_attempt
       (order_id, run_id, worker, operator_worker, session_id, provider_session_id, station, harness, model, tier,
        started_at, ended_at, recorded_at, kind, outcome, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finished', ?, ?)`,
    [
      orderId,
      runId,
      worker,
      started?.operator_worker ?? null,
      started?.session_id ?? null,
      started?.provider_session_id ?? null,
      station,
      started?.harness ?? null,
      started?.model ?? null,
      started?.tier ?? null,
      started?.started_at ?? at,
      at,
      at,
      outcome,
      reason ?? null,
    ],
  );
}

export function queueOrder(db: Database, order: Order, worker: string, at = now()): number {
  return db.transaction(() => {
    db.run(
      `INSERT INTO factory_order
       (id, project, title, line, description, priority, hold, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        order.id,
        order.project,
        order.title,
        order.line ?? "feat",
        order.description ?? null,
        order.priority ?? "unset",
        order.hold ?? null,
        at,
        at,
      ],
    );
    return appendOrderEventInTransaction(
      db,
      order.id,
      { kind: "queued", worker, evidence: order.provenance },
      at,
    );
  })();
}

/**
 * A stopped floor finishes what it holds and takes nothing new: killing a worker
 * mid-write leaves a worktree nobody owns and a commit half made, so the refusal
 * sits here, where work enters the floor, and nowhere an order already running passes.
 */
export function claimOrder(
  db: Database,
  orderId: string,
  claim: OrderClaim,
  worker: string,
  at = now(),
  cwd: string = process.cwd(),
): number {
  return db.transaction(() => {
    const stop = liveStop(db);
    if (stop) {
      throw new FactoryStopError(
        "floor_stopped",
        `the factory is stopped and takes no new order: ${stop.reason} ` +
          `(${stop.pulledBy}, ${stop.pulledAt}); clear it with \`dim factory clear\``,
      );
    }
    const order = db.query("SELECT status, hold, run_id FROM factory_order WHERE id = ?").get(orderId) as {
      status: OrderStatus;
      hold: string | null;
      run_id: string | null;
    } | null;
    if (!order) throw new Error(`order not found: ${orderId}`);
    if (order.hold) {
      throw new FactoryStopError(
        "order_held",
        `order ${orderId} is held and the owner releases it: ${order.hold}`,
      );
    }
    // A move hands the order to the next station rather than finishing it, and lets go of
    // the run that held it, so the hand waiting there takes it while the order stays
    // `working`. What refuses a second hand is a first one still there.
    const holder = liveHolder(db, orderId);
    if (holder) {
      throw new Error(`order ${orderId} is already working under ${holder.runId}, held by ${holder.worker}`);
    }
    if (order.status !== "queued" && order.status !== "working") {
      throw new Error(`order ${orderId} is already ${order.status}`);
    }
    const operatorRole = db
      .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
      .get(claim.operatorWorker)?.role;
    if (operatorRole !== "operator") throw new Error(`worker ${claim.operatorWorker} is not an operator`);
    // Made before the claim is written, and inside the same transaction, so a claim
    // that cannot get a worktree writes no claim — reusing one already there is how
    // a failed order is taken again in place.
    createWorktree(orderId, cwd);
    db.run(
      `UPDATE factory_order SET run_id = ?, session_id = ?, station = ?,
         status = 'working', claimed_at = ?, updated_at = ? WHERE id = ?`,
      [claim.runId, claim.sessionId ?? null, claim.station ?? null, at, at, orderId],
    );
    db.run(
      `INSERT INTO factory_order_attempt
         (order_id, run_id, worker, operator_worker, session_id, provider_session_id, station, harness, model, tier,
          started_at, recorded_at, kind, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', 'running')`,
      [
        orderId,
        claim.runId,
        worker,
        claim.operatorWorker,
        claim.sessionId ?? null,
        claim.providerSessionId ?? null,
        claim.station ?? null,
        claim.harness ?? null,
        claim.model ?? null,
        claim.tier ?? null,
        at,
        at,
      ],
    );
    return appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "claimed", worker, sessionId: claim.sessionId, station: claim.station },
      at,
    );
  })();
}

/**
 * The projection follows the move because that column is what a card is read by
 * (`src/factory-wall.ts` prefers it over the latest event's station), and the
 * event ledger keeps every station the order passed through.
 *
 * The run goes with it: the hand that worked the order at the station it is leaving is
 * done with it, and an order carrying no run is one the next station's worker can claim.
 */
export function moveOrder(
  db: Database,
  orderId: string,
  station: string,
  worker: string,
  at = now(),
): number {
  if (station === "ship" || station === "dim-station-ship") {
    const role = db
      .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
      .get(worker)?.role;
    if (role !== "operator")
      throw new ReviewApprovalRefused("worker_not_operator", `${worker} cannot move an order to ship`);
    assertReviewApproved(db, orderId);
  }
  return db.transaction(() => {
    const current = db
      .query<{ run_id: string | null }, [string]>("SELECT run_id FROM factory_order WHERE id = ?")
      .get(orderId);
    const event = appendOrderEventInTransaction(db, orderId, { kind: "moved", worker, station }, at);
    db.run("UPDATE factory_order SET station = ?, run_id = NULL, session_id = NULL WHERE id = ?", [
      station,
      orderId,
    ]);
    recordAttemptFinish(
      db,
      orderId,
      current?.run_id ?? null,
      worker,
      station,
      "succeeded",
      `handed to ${station}`,
      at,
    );
    return event;
  })();
}

function latestOrderCommit(db: Database, orderId: string): { sha: string; recordedAt: string } | null {
  return db
    .query<{ sha: string; recordedAt: string }, [string]>(
      "SELECT sha, recorded_at AS recordedAt FROM factory_order_commit WHERE order_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1",
    )
    .get(orderId);
}

export function assertBuildReady(db: Database, orderId: string): { sha: string } {
  const commit = latestOrderCommit(db, orderId);
  if (!commit) throw new OrderNotDone("build_not_approved", `order ${orderId} has no build commit to review`);
  return { sha: commit.sha };
}

function latestReview(
  db: Database,
  orderId: string,
): { id: number; outcome: string | null; headSha: string } | null {
  return db
    .query<{ id: number; outcome: string | null; headSha: string }, [string]>(
      "SELECT id, outcome, head_sha AS headSha FROM factory_order_review WHERE order_id = ? ORDER BY round DESC, id DESC LIMIT 1",
    )
    .get(orderId);
}

export function assertReviewApproved(db: Database, orderId: string): void {
  const review = latestReview(db, orderId);
  if (!review) throw new OrderNotDone("review_not_approved", `order ${orderId} has no review to approve`);
  const commit = latestOrderCommit(db, orderId);
  if (!commit || commit.sha !== review.headSha) {
    throw new OrderNotDone(
      "review_not_approved",
      `order ${orderId} has a commit newer than its approved review`,
    );
  }
  const approved = db
    .query(
      "SELECT 1 FROM factory_order_event WHERE order_id = ? AND kind = 'review_approved' AND review_id = ?",
    )
    .get(orderId, review.id);
  if (!approved) {
    throw new OrderNotDone(
      "review_not_approved",
      `review ${review.id} for order ${orderId} is not approved by the operator`,
    );
  }
}

/** Current state rather than history: nothing has wanted to read back what an order
 *  used to be ranked at, and a row that wants one is its own change. */
export function setOrderPriority(
  db: Database,
  orderId: string,
  priority: OrderPriority,
  worker?: string,
  at = now(),
): void {
  db.transaction(() => {
    const result = db.run("UPDATE factory_order SET priority = ?, updated_at = ? WHERE id = ?", [
      priority,
      at,
      orderId,
    ]);
    if (result.changes !== 1) throw new Error(`order not found: ${orderId}`);
    if (worker) {
      appendOrderEventInTransaction(
        db,
        orderId,
        { kind: "priority_changed", worker, evidence: { priority } },
        at,
      );
    }
  })();
}

export function setOrderHold(
  db: Database,
  orderId: string,
  hold: string | null,
  worker?: string,
  at = now(),
): void {
  db.transaction(() => {
    const result = setOrderHoldInTransaction(db, orderId, hold, at);
    if (result.changes !== 1) throw new Error(`order not found: ${orderId}`);
    if (worker) {
      appendOrderEventInTransaction(
        db,
        orderId,
        {
          kind: hold === null ? "hold_released" : "hold_set",
          worker,
          holdType: hold ?? undefined,
          evidence: { hold },
        },
        at,
      );
    }
  })();
}

function setOrderHoldInTransaction(db: Database, orderId: string, hold: string | null, at: string) {
  return db.run("UPDATE factory_order SET hold = ?, updated_at = ? WHERE id = ?", [hold, at, orderId]);
}

function recordOwnerVerdictInTransaction(
  db: Database,
  orderId: string,
  decision: "approved" | "returned" | "held" | "dropped",
  grounds: string,
  worker: string,
  at: string,
): number {
  if (grounds.trim() === "") throw new Error("owner verdict grounds must not be empty");
  const sessionId = db
    .query<{ session_id: string | null }, [string]>("SELECT session_id FROM factory_worker WHERE name = ?")
    .get(worker)?.session_id;
  const written = db.run(
    `INSERT INTO factory_order_verdict
       (order_id, decision, grounds, worker, session_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [orderId, decision, grounds, worker, sessionId ?? null, at],
  );
  const id = Number(written.lastInsertRowid);
  appendOrderEventInTransaction(
    db,
    orderId,
    { kind: "owner_verdict_recorded", worker, evidence: { decision, verdictId: id, grounds } },
    at,
  );
  return id;
}

function recordDeliveryInTransaction(
  db: Database,
  orderId: string,
  kind: "integration" | "delivery",
  outcome: "succeeded" | "failed",
  target: string,
  commitSha: string | null,
  worker: string,
  at: string,
  reason?: string,
): number {
  const sessionId = db
    .query<{ session_id: string | null }, [string]>("SELECT session_id FROM factory_worker WHERE name = ?")
    .get(worker)?.session_id;
  const written = db.run(
    `INSERT INTO factory_order_delivery
       (order_id, kind, outcome, target, commit_sha, worker, session_id, recorded_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orderId, kind, outcome, target, commitSha, worker, sessionId ?? null, at, reason ?? null],
  );
  appendOrderEventInTransaction(
    db,
    orderId,
    {
      kind: kind === "integration" ? "integration_recorded" : "delivery_recorded",
      worker,
      commitSha: commitSha ?? undefined,
      reason,
      evidence: { deliveryId: Number(written.lastInsertRowid), outcome },
    },
    at,
  );
  return Number(written.lastInsertRowid);
}

export function returnOrderArtifact(
  db: Database,
  orderId: string,
  operator: string,
  reason: string,
  at = now(),
): void {
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(operator)?.role;
  if (role !== "operator") throw new Error(`worker ${operator} is not an operator`);
  if (reason.trim() === "") throw new Error("artifact return reason must not be empty");
  db.transaction(() => {
    const order = db
      .query<{ status: OrderStatus; station: string | null; hold: string | null }, [string]>(
        "SELECT status, station, hold FROM factory_order WHERE id = ?",
      )
      .get(orderId);
    if (order?.status !== "working" || order.hold !== APPROVAL_HOLD) {
      throw new Error(`order ${orderId} has no station artifact awaiting owner approval`);
    }
    const station = order.station?.replace("dim-station-", "");
    let returned: OrderEvent;
    if (station === "plan") {
      const artifact = db
        .query<{ id: number }, [string]>(
          "SELECT id FROM factory_order_plan WHERE order_id = ? ORDER BY revision DESC, id DESC LIMIT 1",
        )
        .get(orderId);
      if (!artifact) throw new Error(`order ${orderId} has no Plan artifact to return`);
      if (
        db
          .query(
            "SELECT 1 FROM factory_order_event WHERE order_id = ? AND kind = 'plan_approved' AND plan_id = ?",
          )
          .get(orderId, artifact.id)
      ) {
        throw new Error(`order ${orderId} has an approved Plan artifact`);
      }
      returned = {
        kind: "artifact_returned",
        worker: operator,
        station: order.station ?? undefined,
        planId: artifact.id,
        reason,
      };
    } else if (station === "build") {
      const artifact = db
        .query<{ id: number; head_sha: string }, [string]>(
          "SELECT id, head_sha FROM factory_order_build WHERE order_id = ? ORDER BY revision DESC, id DESC LIMIT 1",
        )
        .get(orderId);
      if (!artifact) throw new Error(`order ${orderId} has no Build artifact to return`);
      if (
        db
          .query(
            "SELECT 1 FROM factory_order_event WHERE order_id = ? AND kind = 'build_approved' AND commit_sha = ?",
          )
          .get(orderId, artifact.head_sha)
      ) {
        throw new Error(`order ${orderId} has an approved Build artifact`);
      }
      returned = {
        kind: "artifact_returned",
        worker: operator,
        station: order.station ?? undefined,
        buildId: artifact.id,
        commitSha: artifact.head_sha,
        reason,
      };
    } else if (station === "review") {
      const artifact = db
        .query<{ review_id: number; outcome: string | null; findings: number }, [string]>(
          `SELECT a.review_id, r.outcome,
                  (SELECT count(*) FROM factory_order_finding f WHERE f.review_id = r.id) AS findings
           FROM factory_order_review_artifact a
           JOIN factory_order_review r ON r.id = a.review_id
           WHERE a.order_id = ? ORDER BY a.id DESC LIMIT 1`,
        )
        .get(orderId);
      if (!artifact) throw new Error(`order ${orderId} has no Review artifact to return`);
      if (artifact.outcome !== "closed" || artifact.findings !== 0) {
        throw new Error(`review ${artifact.review_id} is not a clean Review artifact`);
      }
      if (
        db
          .query(
            "SELECT 1 FROM factory_order_event WHERE order_id = ? AND kind = 'review_approved' AND review_id = ?",
          )
          .get(orderId, artifact.review_id)
      ) {
        throw new Error(`order ${orderId} has an approved Review artifact`);
      }
      returned = {
        kind: "artifact_returned",
        worker: operator,
        station: order.station ?? undefined,
        reviewId: artifact.review_id,
        reason,
      };
    } else {
      throw new Error(`order ${orderId} is at ${order.station ?? "no station"}, which has no artifact gate`);
    }
    appendOrderEventInTransaction(db, orderId, returned, at);
    recordOwnerVerdictInTransaction(db, orderId, "returned", reason, operator, at);
    setOrderHoldInTransaction(db, orderId, null, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "hold_released", worker: operator, evidence: { hold: null } },
      at,
    );
  })();
}

/**
 * The owner's decision that an order will not be built, kept as a status rather than a
 * delete: why an order was not built is worth finding later, and a deletion is the one write
 * this record cannot hold. What it is refused on is `assertDroppable`.
 */
export function dropOrder(db: Database, orderId: string, reason: string, worker: string, at = now()): number {
  return db.transaction(() => {
    recordOwnerVerdictInTransaction(db, orderId, "dropped", reason, worker, at);
    return appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "dropped", worker, status: "dropped", reason },
      at,
    );
  })();
}

/**
 * Corrects a queued order's own words. Refused once anything has claimed it: a claim copies
 * the description into the record, so amending afterward would leave a worker building to
 * one statement while the queue shows another.
 */
export function amendOrder(
  db: Database,
  orderId: string,
  changes: { title?: string; description?: string },
  at = now(),
): void {
  assertOrderQueued(db, orderId, "amended");
  db.run(
    `UPDATE factory_order SET title = coalesce(?, title), description = coalesce(?, description),
       updated_at = ? WHERE id = ?`,
    [changes.title ?? null, changes.description ?? null, at, orderId],
  );
}

export function orderStatus(db: Database, orderId: string): OrderStatus {
  const order = db.query("SELECT status FROM factory_order WHERE id = ?").get(orderId) as {
    status: OrderStatus;
  } | null;
  if (!order) throw new Error(`order not found: ${orderId}`);
  return order.status;
}

export function isActiveOrderRun(db: Database, orderId: string, runId: string): boolean {
  return Boolean(
    db
      .query<{ one: number }, [string, string, string, string]>(
        `SELECT 1 AS one
         FROM factory_order o
         WHERE o.id = ? AND o.run_id = ?
           AND EXISTS (
             SELECT 1 FROM factory_order_attempt a
             WHERE a.order_id = o.id AND a.run_id = ? AND a.kind = 'started' AND a.outcome = 'running'
           )
           AND NOT EXISTS (
             SELECT 1 FROM factory_order_attempt a
             WHERE a.order_id = o.id AND a.run_id = ? AND a.kind = 'finished'
           )`,
      )
      .get(orderId, runId, runId, runId),
  );
}

export type ReturnedOrderArtifact =
  | { station: "plan"; reason: string; planId: number; body: string }
  | { station: "build"; reason: string; buildId: number; body: string; headSha: string }
  | {
      station: "review";
      reason: string;
      reviewId: number;
      body: string;
      baseSha: string;
      headSha: string;
    };

export function returnedOrderArtifact(
  db: Database,
  orderId: string,
  station: "plan",
): Extract<ReturnedOrderArtifact, { station: "plan" }> | null;
export function returnedOrderArtifact(
  db: Database,
  orderId: string,
  station: "build",
): Extract<ReturnedOrderArtifact, { station: "build" }> | null;
export function returnedOrderArtifact(
  db: Database,
  orderId: string,
  station: "review",
): Extract<ReturnedOrderArtifact, { station: "review" }> | null;
export function returnedOrderArtifact(
  db: Database,
  orderId: string,
  station: "plan" | "build" | "review",
): ReturnedOrderArtifact | null;
export function returnedOrderArtifact(
  db: Database,
  orderId: string,
  station: "plan" | "build" | "review",
): ReturnedOrderArtifact | null {
  const artifactEvent = {
    plan: "plan_artifact_written",
    build: "build_artifact_written",
    review: "review_artifact_written",
  }[station];
  const event = db
    .query<
      { reason: string; plan_id: number | null; build_id: number | null; review_id: number | null },
      [string, string, string, string]
    >(
      `SELECT returned.reason, returned.plan_id, returned.build_id, returned.review_id
       FROM factory_order_event returned
       WHERE returned.order_id = ? AND returned.kind = 'artifact_returned'
         AND returned.station IN (?, ?)
         AND NOT EXISTS (
           SELECT 1 FROM factory_order_event written
           WHERE written.order_id = returned.order_id AND written.kind = ?
             AND written.id > returned.id
         )
       ORDER BY returned.id DESC LIMIT 1`,
    )
    .get(orderId, station, `dim-station-${station}`, artifactEvent);
  if (!event) return null;
  if (station === "plan" && event.plan_id !== null) {
    const artifact = db
      .query<{ body: string }, [number]>("SELECT body FROM factory_order_plan WHERE id = ?")
      .get(event.plan_id);
    if (!artifact) throw new Error(`Plan artifact ${event.plan_id} is missing`);
    return { station, reason: event.reason, planId: event.plan_id, body: artifact.body };
  }
  if (station === "build" && event.build_id !== null) {
    const artifact = db
      .query<{ body: string; head_sha: string }, [number]>(
        "SELECT body, head_sha FROM factory_order_build WHERE id = ?",
      )
      .get(event.build_id);
    if (!artifact) throw new Error(`Build artifact ${event.build_id} is missing`);
    return {
      station,
      reason: event.reason,
      buildId: event.build_id,
      body: artifact.body,
      headSha: artifact.head_sha,
    };
  }
  if (station === "review" && event.review_id !== null) {
    const artifact = db
      .query<{ body: string; base_sha: string; head_sha: string }, [number]>(
        `SELECT a.body, r.base_sha, r.head_sha
         FROM factory_order_review_artifact a
         JOIN factory_order_review r ON r.id = a.review_id
         WHERE a.review_id = ? ORDER BY a.revision DESC LIMIT 1`,
      )
      .get(event.review_id);
    if (!artifact) throw new Error(`Review artifact ${event.review_id} is missing`);
    return {
      station,
      reason: event.reason,
      reviewId: event.review_id,
      body: artifact.body,
      baseSha: artifact.base_sha,
      headSha: artifact.head_sha,
    };
  }
  throw new Error(`order ${orderId} has an incomplete ${station} artifact return`);
}

function assertReturnedArtifactRevised(
  db: Database,
  orderId: string,
  station: "plan" | "build" | "review",
): void {
  if (returnedOrderArtifact(db, orderId, station)) {
    throw new OrderNotDone(
      "artifact_revision_required",
      `order ${orderId} must receive a new ${station} artifact after its return before approval`,
    );
  }
}

/** `worktree` is where the completion gate reads git: the checkout the work was done
 *  in, which the caller knows and a stored path is free to be wrong about. */
export function appendOrderEvent(
  db: Database,
  orderId: string,
  event: OrderEvent,
  at = now(),
  worktree = process.cwd(),
): number {
  return db.transaction(() => appendOrderEventInTransaction(db, orderId, event, at, worktree))();
}

/** A failed attempt and the operator's act of making it retryable are separate moments. */
export function recoverOrderFailure(
  db: Database,
  orderId: string,
  operator: string,
  reason: string | undefined,
  at = now(),
  worktree = process.cwd(),
): void {
  db.transaction(() => {
    const order = db
      .query<{ run_id: string | null; station: string | null }, [string]>(
        "SELECT run_id, station FROM factory_order WHERE id = ? AND status = 'working'",
      )
      .get(orderId);
    if (!order) throw new Error(`order ${orderId} is not working`);
    const attemptWorker = order.run_id
      ? (db
          .query<{ worker: string | null }, [string, string]>(
            "SELECT worker FROM factory_order_attempt WHERE order_id = ? AND run_id = ? AND kind = 'started'",
          )
          .get(orderId, order.run_id)?.worker ?? undefined)
      : undefined;
    appendOrderEventInTransaction(
      db,
      orderId,
      {
        kind: "failed",
        ...(attemptWorker ? { worker: attemptWorker } : {}),
        station: order.station ?? undefined,
        reason,
      },
      at,
      worktree,
    );
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "recovered", worker: operator, station: order.station ?? undefined, reason },
      at,
      worktree,
    );
  })();
}

/** Returns the row it wrote, which is the id a command prints for the spool to attribute. */
function appendOrderEventInTransaction(
  db: Database,
  orderId: string,
  event: OrderEvent,
  at: string,
  worktree = process.cwd(),
): number {
  if (isTerminalOrderStatus(event.kind as OrderStatus) && event.status !== event.kind) {
    throw new Error(`terminal event kind must match its status: ${event.kind}`);
  }
  if (event.status && isTerminalOrderStatus(event.status) && event.kind !== event.status) {
    throw new Error(`terminal event status must match its kind: ${event.status}`);
  }
  const order = db.query("SELECT status, run_id, station FROM factory_order WHERE id = ?").get(orderId) as {
    status: OrderStatus;
    run_id: string | null;
    station: string | null;
  } | null;
  if (!order) throw new Error(`order not found: ${orderId}`);
  if (!event.worker && event.kind !== "failed") {
    throw new Error(`order ${orderId} ${event.kind} requires a worker`);
  }
  if (isTerminalOrderStatus(order.status)) {
    throw new Error(`order ${orderId} is already ${order.status}`);
  }
  if (event.kind === "dropped") {
    assertDroppable(db, orderId);
  } else if (
    event.kind !== "queued" &&
    event.kind !== "claimed" &&
    event.kind !== "recovered" &&
    event.kind !== "provenance_recorded" &&
    event.kind !== "priority_changed" &&
    event.kind !== "hold_set" &&
    event.kind !== "hold_released" &&
    event.kind !== "owner_verdict_recorded"
  ) {
    if (order.status !== "working") {
      const action = VERB_FOR_KIND[event.kind] ?? event.kind;
      throw new Error(`order ${orderId} must be working before it can ${action}`);
    }
    if (event.kind === "completed") {
      assertChecked(db, orderId);
      assertIntegrated(db, orderId, worktree);
    }
  }

  const written = db.run(
    `INSERT INTO factory_order_event
       (order_id, ts, kind, worker, session_id, station, commit_sha, check_id, review_id, finding_id, plan_id,
        build_id, hold_type, status, reason, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventValues(orderId, event, event.ts ?? at),
  );
  // A failure hands the work back rather than ending it, so the row returns to the
  // queue and the run it was claimed for is cleared with it.
  const projected = event.kind === "failed" ? "queued" : (event.status ?? null);
  db.run(
    `UPDATE factory_order SET status = coalesce(?, status), updated_at = ?,
       completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
       stop_reason = coalesce(?, stop_reason),
       run_id = CASE WHEN ? = 'failed' THEN NULL ELSE run_id END,
       claimed_at = CASE WHEN ? = 'failed' THEN NULL ELSE claimed_at END
       WHERE id = ?`,
    [
      projected,
      event.ts ?? at,
      projected,
      event.ts ?? at,
      event.reason ?? null,
      event.kind,
      event.kind,
      orderId,
    ],
  );
  if (event.kind === "failed") {
    recordAttemptFinish(
      db,
      orderId,
      order.run_id,
      event.worker,
      order.station,
      "failed",
      event.reason,
      event.ts ?? at,
    );
  } else if (event.kind === "completed") {
    recordAttemptFinish(
      db,
      orderId,
      order.run_id,
      event.worker,
      order.station,
      "succeeded",
      undefined,
      event.ts ?? at,
    );
  }
  writeTrace(
    db,
    {
      event: "order.lifecycle",
      orderId,
      station: event.station ?? order.station ?? undefined,
      worker: event.worker,
      sessionId: event.sessionId,
      fields: {
        kind: event.kind,
        status: event.status ?? projected,
        reason: event.reason ?? null,
      },
    },
    event.ts ?? at,
  );
  return Number(written.lastInsertRowid);
}

export function recordOrderCommit(
  db: Database,
  orderId: string,
  sha: string,
  worker: string,
  subject?: string,
  at = now(),
): number {
  assertOrderBuilding(db, orderId);
  return db.transaction(() => {
    db.run("INSERT INTO factory_order_commit (order_id, sha, subject, recorded_at) VALUES (?, ?, ?, ?)", [
      orderId,
      sha,
      subject ?? null,
      at,
    ]);
    return appendOrderEventInTransaction(db, orderId, { kind: "commit_created", worker, commitSha: sha }, at);
  })();
}

export type OrderFile = { path: string; added?: number; removed?: number };

export function recordOrderFile(
  db: Database,
  orderId: string,
  file: OrderFile,
  worker: string,
  at = now(),
): void {
  assertOrderBuilding(db, orderId);
  db.run(
    "INSERT INTO factory_order_file (order_id, worker, path, added, removed, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
    [orderId, worker, file.path, file.added ?? null, file.removed ?? null, at],
  );
}

export function recordOrderCheck(
  db: Database,
  orderId: string,
  check: { command: string; exitCode: number; startedAt?: string; finishedAt?: string; result?: string },
  worker: string,
  at = now(),
): number {
  assertOrderWorking(db, orderId);
  return db.transaction(() => {
    const result = db.run(
      `INSERT INTO factory_order_check (order_id, command, exit_code, started_at, finished_at, result, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        check.command,
        check.exitCode,
        check.startedAt ?? null,
        check.finishedAt ?? at,
        check.result ?? null,
        at,
      ],
    );
    const id = Number(result.lastInsertRowid);
    return appendOrderEventInTransaction(db, orderId, { kind: "check_finished", worker, checkId: id }, at);
  })();
}

export type ReviewRound = { id: number; round: number; reviewer: string | null };

export class ReviewNotOpen extends Error {
  constructor(
    readonly code: "review_open" | "review_unknown" | "review_closed" | "review_not_its_reviewer",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Opens a round over the commits between two shas. A round reads a sha rather than a tree
 * because a sha cannot move while it is being read, so what the reviewer saw and what
 * ships are the same thing without anything having to hold the worktree still.
 *
 * The reviewer is minted by the caller that spawns it and named here, which is what lets a
 * finding be refused unless it comes from the hand this round was opened for.
 */
export function openOrderReview(
  db: Database,
  orderId: string,
  round: { reviewer: string; baseSha: string; headSha: string },
  worker: string,
  at = now(),
): ReviewRound {
  assertOrderWorking(db, orderId);
  return db.transaction(() => {
    const live = db
      .query<{ id: number }, [string]>(
        "SELECT id FROM factory_order_review WHERE order_id = ? AND closed_at IS NULL",
      )
      .get(orderId);
    if (live) {
      throw new ReviewNotOpen("review_open", `order ${orderId} already has review ${live.id} open`);
    }
    const last = (db
      .query<{ n: number }, [string]>(
        "SELECT coalesce(max(round), 0) AS n FROM factory_order_review WHERE order_id = ?",
      )
      .get(orderId)?.n ?? 0) as number;
    const next = last + 1;
    const written = db.run(
      `INSERT INTO factory_order_review (order_id, round, reviewer, base_sha, head_sha, opened_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, next, round.reviewer, round.baseSha, round.headSha, at],
    );
    const id = Number(written.lastInsertRowid);
    appendOrderEventInTransaction(db, orderId, { kind: "review_opened", worker, reviewId: id }, at);
    return { id, round: next, reviewer: round.reviewer };
  })();
}

export function openAssignedOrderReview(
  db: Database,
  orderId: string,
  round: { assignmentId: string; baseSha: string; headSha: string },
  worker: string,
  at = now(),
): ReviewRound {
  assertOrderWorking(db, orderId);
  return db.transaction(() => {
    const live = db
      .query<{ id: number }, [string]>(
        "SELECT id FROM factory_order_review WHERE order_id = ? AND closed_at IS NULL",
      )
      .get(orderId);
    if (live) throw new ReviewNotOpen("review_open", `order ${orderId} already has review ${live.id} open`);
    const next =
      ((db
        .query<{ n: number }, [string]>(
          "SELECT coalesce(max(round), 0) AS n FROM factory_order_review WHERE order_id = ?",
        )
        .get(orderId)?.n ?? 0) as number) + 1;
    const written = db.run(
      `INSERT INTO factory_order_review
       (order_id, round, reviewer, assignment_id, base_sha, head_sha, opened_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      [orderId, next, round.assignmentId, round.baseSha, round.headSha, at],
    );
    const id = Number(written.lastInsertRowid);
    appendOrderEventInTransaction(db, orderId, { kind: "review_opened", worker, reviewId: id }, at);
    return { id, round: next, reviewer: null };
  })();
}

/**
 * Written from the spawned reviewer's exit rather than from anything it said: a reviewer
 * that died and one that finished having found nothing are the same empty set of findings,
 * and only the exit code tells them apart.
 */
export function closeOrderReview(
  db: Database,
  reviewId: number,
  outcome: "closed" | "aborted",
  worker: string,
  at = now(),
  reason?: string,
): number {
  const row = db
    .query<{ order_id: string; closed_at: string | null }, [number]>(
      "SELECT order_id, closed_at FROM factory_order_review WHERE id = ?",
    )
    .get(reviewId);
  if (!row) throw new ReviewNotOpen("review_unknown", `no review ${reviewId}`);
  if (row.closed_at !== null) {
    throw new ReviewNotOpen("review_closed", `review ${reviewId} closed at ${row.closed_at}`);
  }
  return db.transaction(() => {
    db.run("UPDATE factory_order_review SET closed_at = ?, outcome = ? WHERE id = ?", [
      at,
      outcome,
      reviewId,
    ]);
    const event = appendOrderEventInTransaction(
      db,
      row.order_id,
      { kind: "review_closed", worker, reviewId, reason },
      at,
    );
    const findings =
      db
        .query<{ n: number }, [number]>("SELECT count(*) AS n FROM factory_order_finding WHERE review_id = ?")
        .get(reviewId)?.n ?? 0;
    if (outcome === "closed" && findings === 0 && nextOrderSlice(db, row.order_id) === null) {
      setOrderHoldInTransaction(db, row.order_id, APPROVAL_HOLD, at);
      appendOrderEventInTransaction(
        db,
        row.order_id,
        { kind: "hold_set", worker, holdType: APPROVAL_HOLD, evidence: { hold: APPROVAL_HOLD } },
        at,
      );
    }
    return event;
  })();
}

export function recordOrderReviewArtifact(
  db: Database,
  orderId: string,
  body: string,
  worker: string,
  at = now(),
): number {
  if (body.trim() === "") throw new Error("Review artifact body must not be empty");
  const review = db
    .query<
      { id: number; reviewer: string | null; assignment_id: string | null; closed_at: string | null },
      [string]
    >(
      `SELECT r.id, coalesce(r.reviewer, a.accepted_worker) AS reviewer, r.assignment_id, r.closed_at
       FROM factory_order_review r
       LEFT JOIN factory_worker_assignment a ON a.id = r.assignment_id
       WHERE r.order_id = ? ORDER BY r.round DESC LIMIT 1`,
    )
    .get(orderId);
  if (!review) throw new ReviewNotOpen("review_unknown", `order ${orderId} has no review for an artifact`);
  if (review.reviewer !== worker) {
    throw new ReviewNotOpen(
      "review_not_its_reviewer",
      `review ${review.id} belongs to ${review.reviewer}, not ${worker}`,
    );
  }
  assertOrderWorking(db, orderId);
  const returned = returnedOrderArtifact(db, orderId, "review");
  if (review.closed_at !== null && returned?.reviewId !== review.id) {
    throw new ReviewNotOpen("review_closed", `review ${review.id} is closed`);
  }
  if (review.closed_at === null && returned) {
    throw new ReviewNotOpen(
      "review_open",
      `review ${review.id} already has a returned artifact revision in progress`,
    );
  }
  if (review.closed_at !== null) {
    const findings = db
      .query<{ n: number }, [number]>("SELECT count(*) AS n FROM factory_order_finding WHERE review_id = ?")
      .get(review.id)?.n;
    const outcome = db
      .query<{ outcome: string | null }, [number]>("SELECT outcome FROM factory_order_review WHERE id = ?")
      .get(review.id)?.outcome;
    if (outcome !== "closed" || findings) {
      throw new ReviewNotOpen("review_closed", `review ${review.id} is not a clean review`);
    }
  }
  return db.transaction(() => {
    const revision = (db
      .query<{ revision: number }, [number]>(
        "SELECT coalesce(max(revision), 0) + 1 AS revision FROM factory_order_review_artifact WHERE review_id = ?",
      )
      .get(review.id)?.revision ?? 1) as number;
    const written = db.run(
      `INSERT INTO factory_order_review_artifact (order_id, review_id, revision, worker, body, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, review.id, revision, worker, body, at],
    );
    const artifactId = Number(written.lastInsertRowid);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "review_artifact_written", worker, reviewId: review.id },
      at,
    );
    if (review.closed_at !== null) {
      setOrderHoldInTransaction(db, orderId, APPROVAL_HOLD, at);
      appendOrderEventInTransaction(
        db,
        orderId,
        { kind: "hold_set", worker, holdType: APPROVAL_HOLD, evidence: { hold: APPROVAL_HOLD } },
        at,
      );
    }
    return artifactId;
  })();
}

/**
 * The reviewer's own act, refused from any hand but the one this round was opened for.
 * What it raises carries no answer, because whether the finding is fixed or refused is the
 * builder's to say and a hand may only write what it did.
 *
 * Returns the finding rather than the event, since answering it is the next act and the
 * finding is what that act names.
 */
export function raiseOrderFinding(
  db: Database,
  orderId: string,
  finding: { dimension: string; summary: string },
  worker: string,
  at = now(),
): number {
  const row = db
    .query<{ id: number; reviewer: string | null }, [string]>(
      `SELECT r.id, coalesce(r.reviewer, a.accepted_worker) AS reviewer
       FROM factory_order_review r
       LEFT JOIN factory_worker_assignment a ON a.id = r.assignment_id
       WHERE r.order_id = ? AND r.closed_at IS NULL`,
    )
    .get(orderId);
  if (!row) {
    throw new ReviewNotOpen(
      "review_unknown",
      `order ${orderId} has no review open, and a finding belongs to the reading that raised it`,
    );
  }
  if (row.reviewer !== worker) {
    throw new ReviewNotOpen(
      "review_not_its_reviewer",
      `review ${row.id} was opened for ${row.reviewer}, and a finding is worth only what the hand ` +
        `that read the diff is worth; ${worker} did not read it`,
    );
  }
  assertOrderWorking(db, orderId);
  return db.transaction(() => {
    const result = db.run(
      `INSERT INTO factory_order_finding (order_id, review_id, dimension, summary, raised_at)
       VALUES (?, ?, ?, ?, ?)`,
      [orderId, row.id, finding.dimension, finding.summary, at],
    );
    const id = Number(result.lastInsertRowid);
    appendOrderEventInTransaction(db, orderId, { kind: "finding_raised", worker, findingId: id }, at);
    return id;
  })();
}

export class FindingNotOpen extends Error {
  constructor(
    readonly code: "finding_unknown" | "finding_answered",
    message: string,
  ) {
    super(message);
  }
}

/** The builder's answer to a finding it did not raise. Answered once: a second answer would
 *  rewrite a judgement the record may already have been read for. */
export function answerOrderFinding(
  db: Database,
  findingId: number,
  answer: { answer: "fixed" | "refused"; resolution?: string },
  worker: string,
  at = now(),
): number {
  const row = db
    .query<{ order_id: string; answer: string | null }, [number]>(
      "SELECT order_id, answer FROM factory_order_finding WHERE id = ?",
    )
    .get(findingId);
  if (!row) throw new FindingNotOpen("finding_unknown", `no finding ${findingId}`);
  if (row.answer !== null) {
    throw new FindingNotOpen("finding_answered", `finding ${findingId} is already ${row.answer}`);
  }
  assertOrderWorking(db, row.order_id);
  return db.transaction(() => {
    db.run("UPDATE factory_order_finding SET answer = ?, resolution = ?, answered_at = ? WHERE id = ?", [
      answer.answer,
      answer.resolution ?? null,
      at,
      findingId,
    ]);
    return appendOrderEventInTransaction(
      db,
      row.order_id,
      { kind: "finding_answered", worker, findingId },
      at,
    );
  })();
}

export function recordOrderEnvironment(
  db: Database,
  orderId: string,
  report: WorkerHookReport,
  at = now(),
): void {
  assertOrderWorking(db, orderId);
  db.run(
    `INSERT INTO factory_order_environment
       (order_id, phase, argv, exit_code, signal, stdout, stderr, resources, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      report.phase,
      JSON.stringify(report.argv),
      report.exitCode,
      report.signal,
      report.stdout,
      report.stderr,
      JSON.stringify(report.resources),
      at,
    ],
  );
}

export function recordOrderDocument(
  db: Database,
  orderId: string,
  path: string,
  worker: string,
  at = now(),
): void {
  assertOrderWorking(db, orderId);
  db.run("INSERT INTO factory_order_document (order_id, worker, path, recorded_at) VALUES (?, ?, ?, ?)", [
    orderId,
    worker,
    path,
    at,
  ]);
}

export function recordOrderPlan(
  db: Database,
  orderId: string,
  body: string,
  worker: string,
  slices: readonly PlanSlice[],
  at = now(),
): number {
  assertOrderWorking(db, orderId);
  const order = db.query("SELECT station FROM factory_order WHERE id = ?").get(orderId) as {
    station: string | null;
  } | null;
  if (order?.station !== "plan" && order?.station !== "dim-station-plan") {
    throw new OrderNotDone(
      "order_not_planning",
      `order ${orderId} must be at plan before a plan can be submitted`,
    );
  }
  if (body.trim() === "") throw new Error("plan body must not be empty");
  if (slices.length === 0) throw new Error("plan must contain at least one slice");
  return db.transaction(() => {
    const revision = (db
      .query<{ revision: number }, [string]>(
        "SELECT coalesce(max(revision), 0) + 1 AS revision FROM factory_order_plan WHERE order_id = ?",
      )
      .get(orderId)?.revision ?? 1) as number;
    const written = db.run(
      "INSERT INTO factory_order_plan (order_id, revision, worker, body, recorded_at) VALUES (?, ?, ?, ?, ?)",
      [orderId, revision, worker, body, at],
    );
    const planId = Number(written.lastInsertRowid);
    for (const [index, slice] of slices.entries()) {
      db.run("INSERT INTO factory_order_slice (plan_id, ordinal, title, outcome) VALUES (?, ?, ?, ?)", [
        planId,
        index + 1,
        slice.title,
        slice.outcome,
      ]);
    }
    appendOrderEventInTransaction(db, orderId, { kind: "plan_artifact_written", worker, planId }, at);
    setOrderHoldInTransaction(db, orderId, APPROVAL_HOLD, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "hold_set", worker, holdType: APPROVAL_HOLD, evidence: { hold: APPROVAL_HOLD } },
      at,
    );
    return planId;
  })();
}

export function recordOrderBuild(
  db: Database,
  orderId: string,
  body: string,
  headSha: string,
  worker: string,
  at = now(),
): number {
  assertOrderWorking(db, orderId);
  const order = db
    .query<{ station: string | null; run_id: string | null }, [string]>(
      "SELECT station, run_id FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  if (order?.station !== "build" && order?.station !== "dim-station-build") {
    throw new OrderNotDone(
      "order_not_building",
      `order ${orderId} must be at build before a build artifact can be submitted`,
    );
  }
  const returned = returnedOrderArtifact(db, orderId, "build");
  if ((order?.run_id === null || order?.run_id === undefined) && !returned?.buildId) {
    throw new OrderNotDone(
      "build_artifact_before_final_slice",
      `order ${orderId} has no active final build turn or returned Build artifact`,
    );
  }
  const next = nextOrderSlice(db, orderId);
  if (next) {
    const last = db
      .query<{ ordinal: number }, [string]>(
        `SELECT max(s.ordinal) AS ordinal
         FROM factory_order_slice s
         JOIN factory_order_plan p ON p.id = s.plan_id
         WHERE p.order_id = ? AND EXISTS (
           SELECT 1 FROM factory_order_event e
           WHERE e.order_id = p.order_id AND e.kind = 'plan_approved' AND e.plan_id = p.id
         )`,
      )
      .get(orderId);
    if (last?.ordinal !== next.ordinal) {
      throw new OrderNotDone(
        "build_artifact_before_final_slice",
        `order ${orderId} must finish its final slice before recording a Build artifact`,
      );
    }
  }
  if (body.trim() === "") throw new Error("build artifact body must not be empty");
  if (headSha.trim() === "") throw new Error("build artifact head must not be empty");
  if (returned && headSha !== returned.headSha) {
    throw new OrderNotDone(
      "build_revision_head_mismatch",
      `order ${orderId} must keep the returned Build artifact on ${returned.headSha}`,
    );
  }
  return db.transaction(() => {
    const revision = (db
      .query<{ revision: number }, [string]>(
        "SELECT coalesce(max(revision), 0) + 1 AS revision FROM factory_order_build WHERE order_id = ?",
      )
      .get(orderId)?.revision ?? 1) as number;
    const written = db.run(
      `INSERT INTO factory_order_build (order_id, revision, worker, body, head_sha, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, revision, worker, body, headSha, at],
    );
    const buildId = Number(written.lastInsertRowid);
    appendOrderEventInTransaction(db, orderId, { kind: "build_artifact_written", worker, buildId }, at);
    setOrderHoldInTransaction(db, orderId, APPROVAL_HOLD, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "hold_set", worker, holdType: APPROVAL_HOLD, evidence: { hold: APPROVAL_HOLD } },
      at,
    );
    return buildId;
  })();
}

export type OrderSlice = PlanSlice & { id: number; ordinal: number };

export function nextOrderSlice(db: Database, orderId: string): OrderSlice | null {
  return db
    .query<OrderSlice, [string]>(
      `SELECT s.id, s.ordinal, s.title, s.outcome
       FROM factory_order_slice s
       JOIN factory_order_plan p ON p.id = s.plan_id
       WHERE p.order_id = ? AND EXISTS (
         SELECT 1 FROM factory_order_event e
         WHERE e.order_id = p.order_id AND e.kind = 'plan_approved' AND e.plan_id = p.id
       ) AND NOT EXISTS (
         SELECT 1 FROM factory_order_slice_completion c WHERE c.slice_id = s.id
       )
       ORDER BY p.revision DESC, p.id DESC, s.ordinal
       LIMIT 1`,
    )
    .get(orderId);
}

export function completeOrderSlice(
  db: Database,
  orderId: string,
  sliceId: number,
  worker: string,
  at = now(),
): void {
  db.transaction(() => {
    assertOrderWorking(db, orderId);
    const order = db
      .query<{ run_id: string | null; station: string | null }, [string]>(
        "SELECT run_id, station FROM factory_order WHERE id = ?",
      )
      .get(orderId);
    const slice = db
      .query<{ id: number }, [string, number]>(
        `SELECT s.id FROM factory_order_slice s
         JOIN factory_order_plan p ON p.id = s.plan_id
         WHERE p.order_id = ? AND s.id = ? AND EXISTS (
           SELECT 1 FROM factory_order_event e
           WHERE e.order_id = p.order_id AND e.kind = 'plan_approved' AND e.plan_id = p.id
         )`,
      )
      .get(orderId, sliceId);
    if (!slice) throw new Error(`slice ${sliceId} does not belong to order ${orderId}'s approved plan`);
    const next = nextOrderSlice(db, orderId);
    if (!next || next.id !== sliceId)
      throw new Error(`slice ${sliceId} is not the next slice for order ${orderId}`);
    db.run("INSERT INTO factory_order_slice_completion (slice_id, worker, completed_at) VALUES (?, ?, ?)", [
      sliceId,
      worker,
      at,
    ]);
    recordAttemptFinish(
      db,
      orderId,
      order?.run_id ?? null,
      worker,
      order?.station ?? null,
      "succeeded",
      undefined,
      at,
    );
    db.run("UPDATE factory_order SET run_id = NULL, session_id = NULL, updated_at = ? WHERE id = ?", [
      at,
      orderId,
    ]);
  })();
}

export function approveOrderPlan(db: Database, orderId: string, worker: string, at = now()): void {
  assertOrderWorking(db, orderId);
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(worker)?.role;
  if (role !== "operator")
    throw new PlanApprovalRefused("worker_not_operator", `worker ${worker} is not an operator`);
  assertReturnedArtifactRevised(db, orderId, "plan");
  const plan = db
    .query<{ id: number }, [string]>(
      "SELECT id FROM factory_order_plan WHERE order_id = ? ORDER BY revision DESC, id DESC LIMIT 1",
    )
    .get(orderId);
  if (!plan) throw new PlanApprovalRefused("plan_missing", `order ${orderId} has no plan to approve`);
  const approved = db
    .query("SELECT id FROM factory_order_event WHERE order_id = ? AND kind = 'plan_approved' AND plan_id = ?")
    .get(orderId, plan.id);
  if (approved)
    throw new PlanApprovalRefused(
      "plan_already_approved",
      `plan ${plan.id} for order ${orderId} is already approved`,
    );
  db.transaction(() => {
    recordOwnerVerdictInTransaction(db, orderId, "approved", "plan approved", worker, at);
    appendOrderEventInTransaction(db, orderId, { kind: "plan_approved", worker, planId: plan.id }, at);
    setOrderHoldInTransaction(db, orderId, null, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "hold_released", worker, evidence: { hold: null } },
      at,
    );
  })();
}

export function approveOrderBuild(
  db: Database,
  orderId: string,
  worker: string,
  reason: string,
  at = now(),
): void {
  assertOrderWorking(db, orderId);
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(worker)?.role;
  if (role !== "operator")
    throw new BuildApprovalRefused("worker_not_operator", `worker ${worker} is not an operator`);
  if (reason.trim() === "") throw new Error("build approval reason must not be empty");
  assertReturnedArtifactRevised(db, orderId, "build");
  const commit = latestOrderCommit(db, orderId);
  if (!commit)
    throw new BuildApprovalRefused("commit_missing", `order ${orderId} has no build commit to approve`);
  const check = db
    .query(
      `SELECT 1 FROM factory_order_check
       WHERE order_id = ? AND exit_code = 0 AND recorded_at >= ? LIMIT 1`,
    )
    .get(orderId, commit.recordedAt);
  if (!check) {
    throw new BuildApprovalRefused(
      "build_not_checked",
      `order ${orderId} has no passing check after its latest build commit`,
    );
  }
  if (nextOrderSlice(db, orderId) !== null) {
    throw new BuildApprovalRefused(
      "build_not_final",
      `order ${orderId} has incomplete slices; build approval belongs after the final slice`,
    );
  }
  const buildArtifact = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM factory_order_build WHERE order_id = ? AND head_sha = ? ORDER BY revision DESC LIMIT 1",
    )
    .get(orderId, commit.sha);
  if (!buildArtifact) {
    throw new BuildApprovalRefused(
      "build_artifact_missing",
      `build ${commit.sha} for order ${orderId} has no artifact recorded by its builder`,
    );
  }
  const approved = db
    .query(
      "SELECT id FROM factory_order_event WHERE order_id = ? AND kind = 'build_approved' AND commit_sha = ?",
    )
    .get(orderId, commit.sha);
  if (approved) {
    throw new BuildApprovalRefused(
      "build_already_approved",
      `build ${commit.sha} for order ${orderId} is already approved`,
    );
  }
  db.transaction(() => {
    recordOwnerVerdictInTransaction(db, orderId, "approved", reason, worker, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "build_approved", worker, commitSha: commit.sha, reason },
      at,
    );
    setOrderHoldInTransaction(db, orderId, null, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "hold_released", worker, evidence: { hold: null } },
      at,
    );
  })();
}

export function approveOrderReview(db: Database, orderId: string, worker: string, at = now()): void {
  assertOrderWorking(db, orderId);
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(worker)?.role;
  if (role !== "operator")
    throw new ReviewApprovalRefused("worker_not_operator", `worker ${worker} is not an operator`);
  assertReturnedArtifactRevised(db, orderId, "review");
  const review = latestReview(db, orderId);
  if (!review) throw new ReviewApprovalRefused("review_missing", `order ${orderId} has no review to approve`);
  if (review.outcome === null)
    throw new ReviewApprovalRefused(
      "review_not_closed",
      `review ${review.id} for order ${orderId} is still open`,
    );
  if (review.outcome !== "closed")
    throw new ReviewApprovalRefused("review_aborted", `review ${review.id} for order ${orderId} was aborted`);
  const artifact = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM factory_order_review_artifact WHERE review_id = ? ORDER BY revision DESC LIMIT 1",
    )
    .get(review.id);
  if (!artifact) {
    throw new ReviewApprovalRefused(
      "review_artifact_missing",
      `review ${review.id} for order ${orderId} has no Review artifact`,
    );
  }
  const findings = db
    .query<{ n: number }, [number]>("SELECT count(*) AS n FROM factory_order_finding WHERE review_id = ?")
    .get(review.id)?.n;
  if (findings) {
    throw new ReviewApprovalRefused(
      "findings_present",
      `review ${review.id} for order ${orderId} has ${findings} finding${findings === 1 ? "" : "s"}`,
    );
  }
  const approved = db
    .query(
      "SELECT 1 FROM factory_order_event WHERE order_id = ? AND kind = 'review_approved' AND review_id = ?",
    )
    .get(orderId, review.id);
  if (approved)
    throw new ReviewApprovalRefused(
      "review_already_approved",
      `review ${review.id} for order ${orderId} is already approved`,
    );
  db.transaction(() => {
    recordOwnerVerdictInTransaction(db, orderId, "approved", "review approved", worker, at);
    appendOrderEventInTransaction(db, orderId, { kind: "review_approved", worker, reviewId: review.id }, at);
    setOrderHoldInTransaction(db, orderId, null, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "hold_released", worker, evidence: { hold: null } },
      at,
    );
  })();
}

/**
 * A check older than the last commit is the case the gate exists to catch: an order
 * that ran the repo's check and then kept committing has no evidence for what it
 * landed. With no commit recorded there is nothing for a check to be older than,
 * so any passing one satisfies it.
 *
 * Both sides are `recorded_at`, the time the row was written, so the two paths
 * are judged on one clock. A check's `finished_at` may be supplied by its caller
 * and is free to say when the check truly ran, which on a loop that checks before
 * committing is earlier than the commit it vouches for.
 */
function assertChecked(db: Database, orderId: string): void {
  const passed = db
    .query(
      `SELECT 1 FROM factory_order_check
       WHERE order_id = ? AND exit_code = 0
         AND recorded_at >= coalesce((SELECT max(recorded_at) FROM factory_order_commit WHERE order_id = ?), '')
       LIMIT 1`,
    )
    .get(orderId, orderId);
  if (!passed) {
    throw new OrderNotDone(
      "order_not_checked",
      `order ${orderId} cannot complete without a check that passed after its last commit: ` +
        `record one with \`dim order check ${orderId} --command "..." --exit 0\`, ` +
        "or stop it as failed.",
    );
  }
}

/**
 * A branch that is finished and unmerged is the state work rots in, so being on
 * the trunk is part of being done rather than a step after it. Where the repo
 * cannot place the commit at all, the refusal says which reading failed rather
 * than reporting the work as unmerged on the strength of a git command that did
 * not answer.
 */
function assertIntegrated(db: Database, orderId: string, worktree: string): void {
  const shas = db
    .query<{ sha: string }, [string]>("SELECT sha FROM factory_order_commit WHERE order_id = ?")
    .all(orderId)
    .map((row) => row.sha);
  if (shas.length === 0) {
    throw new OrderNotDone(
      "order_not_integrated",
      `order ${orderId} recorded no commit, so nothing of it is on the trunk: ` +
        `record what it landed with \`dim order commit ${orderId} --sha <sha>\`, ` +
        "or stop it as failed.",
    );
  }
  const reach = shas.map((sha) => reachesTrunk(worktree, sha));
  if (reach.some((one) => one.reach === "reached")) return;
  const unknown = reach.find((one) => one.reach === "unknown");
  if (unknown && unknown.reach === "unknown") {
    throw new OrderNotDone(
      "order_trunk_unknown",
      `order ${orderId} cannot be placed against a trunk, so nothing can say whether it is ` +
        `integrated: ${unknown.why}.`,
    );
  }
  if (reach.every((one) => one.reach === "absent")) {
    throw new OrderNotDone(
      "order_not_integrated",
      `order ${orderId} recorded commits that ${worktree} does not have, so nothing there can place ` +
        `them: check the shas recorded with \`dim q order ${orderId}\`.`,
    );
  }
  throw new OrderNotDone(
    "order_not_integrated",
    `order ${orderId} has no recorded commit on the trunk: merge its branch before completing it, ` +
      "or stop it as failed.",
  );
}

function assertOrderWorking(db: Database, orderId: string): void {
  const status = orderStatus(db, orderId);
  if (status === "working") return;
  // A queued order is short of the point that takes evidence rather than past it,
  // and this refusal is read by whoever typed the command.
  throw new Error(
    status === "queued" ? `order ${orderId} is not claimed` : `order ${orderId} is already ${status}`,
  );
}

function assertOrderBuilding(db: Database, orderId: string): void {
  assertOrderWorking(db, orderId);
  const order = db.query("SELECT station FROM factory_order WHERE id = ?").get(orderId) as {
    station: string | null;
  } | null;
  if (order?.station === "build" || order?.station === "dim-station-build") return;
  throw new OrderNotDone(
    "order_not_building",
    `order ${orderId} is at ${order?.station ?? "no station"} and must move to build before implementation evidence can be recorded`,
  );
}

/**
 * Lands an order's own commits on the repo's trunk. Nothing here is written back to the
 * order: whether it shipped is the trunk fact `assertIntegrated` already reads, not a bit
 * this sets, which is what lets a repo that opens a pull request instead arrive later
 * without this gate having to change. Held under the factory lock because two orders
 * shipping at once is a race on the same git checkout, not on the database.
 */
export function shipOrder(
  db: Database,
  orderId: string,
  worktree: string,
  env: Env = process.env,
  worker?: string,
): ShipOutcome {
  assertOrderWorking(db, orderId);
  const shas = db
    .query<{ sha: string }, [string]>("SELECT sha FROM factory_order_commit WHERE order_id = ?")
    .all(orderId)
    .map((row) => row.sha);
  if (shas.length === 0) {
    throw new OrderNotDone(
      "order_not_integrated",
      `order ${orderId} recorded no commit, so nothing of it can ship: ` +
        `record what it landed with \`dim order commit ${orderId} --sha <sha>\`.`,
    );
  }
  let outcome: ShipOutcome;
  try {
    outcome = withLock(() => shipToTrunk(worktree, orderId, shas), env);
  } catch (error) {
    if (worker) {
      const at = now();
      const reason = error instanceof Error ? error.message : String(error);
      db.transaction(() => {
        recordDeliveryInTransaction(
          db,
          orderId,
          "delivery",
          "failed",
          orderId,
          shas.at(-1) ?? null,
          worker,
          at,
          reason,
        );
      })();
    }
    throw error;
  }
  if (worker) {
    const at = now();
    db.transaction(() => {
      recordDeliveryInTransaction(
        db,
        orderId,
        "integration",
        "succeeded",
        orderId,
        shas.at(-1) ?? null,
        worker,
        at,
      );
      recordDeliveryInTransaction(
        db,
        orderId,
        "delivery",
        "succeeded",
        orderId,
        shas.at(-1) ?? null,
        worker,
        at,
      );
    })();
  }
  return outcome;
}
