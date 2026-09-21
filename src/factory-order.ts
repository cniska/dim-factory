import type { Database } from "bun:sqlite";
import { FactoryStopError, liveStop } from "./factory-stop";
import { workerIsOver } from "./factory-worker";
import { withLock } from "./lock";
import type { Env } from "./paths";
import { type ShipOutcome, shipToTrunk } from "./ship";
import { reachesTrunk } from "./trunk";
import type { WorkerHookReport } from "./worker-environment";
import { createWorktree } from "./wt-command";

/** What state the order is in. A claim takes it straight to `working`: an order
 *  already exists before a worker sees it, so taking one and starting it are one act.
 *  `dropped` is the owner's decision that the order will not be built, which is a
 *  different fact from an attempt that failed and goes back to `queued`. */
export const ORDER_STATUSES = ["queued", "working", "completed", "dropped"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Binds at creation only: a table already on disk keeps the CHECK it was born with. */
export const ORDER_STATUSES_SQL = ORDER_STATUSES.map((status) => `'${status}'`).join(",");

export type OrderEventKind =
  | "queued"
  | "claimed"
  | "moved"
  | "plan_submitted"
  | "plan_approved"
  | "commit_created"
  | "check_finished"
  | "review_opened"
  | "review_closed"
  | "finding_raised"
  | "finding_answered"
  | "completed"
  | "dropped"
  | "failed";

export const ORDER_PRIORITIES = ["urgent", "high", "medium", "low", "unset"] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

/** What is written down before anyone takes it. The branch and the worktree are
 *  derived from the id, so neither is stored. */
export type Order = {
  id: string;
  project: string;
  title: string;
  description?: string;
  priority?: OrderPriority;
  hold?: string;
};

/** What the operator knows only once it has a worker to hand the order to. Who that
 *  worker is comes from the environment it was started in, never from the claim. */
export type OrderClaim = {
  runId: string;
  sessionId?: string;
  station?: string;
};

export type OrderEvent = {
  kind: OrderEventKind;
  /** Required, because a moment nobody did is not a moment this record can hold. */
  worker: string;
  sessionId?: string;
  station?: string;
  commitSha?: string;
  checkId?: number;
  reviewId?: number;
  findingId?: number;
  planId?: number;
  holdType?: string;
  status?: OrderStatus;
  reason?: string;
  ts?: string;
};

export type OrderNotDoneCode =
  | "order_not_checked"
  | "order_not_integrated"
  | "order_trunk_unknown"
  | "order_not_queued"
  | "order_held_by_run"
  | "order_not_building"
  | "order_not_planning";

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
    event.worker,
    event.sessionId ?? null,
    event.station ?? null,
    event.commitSha ?? null,
    event.checkId ?? null,
    event.reviewId ?? null,
    event.findingId ?? null,
    event.planId ?? null,
    event.holdType ?? null,
    event.status ?? null,
    event.reason ?? null,
  ];
}

export function queueOrder(db: Database, order: Order, worker: string, at = now()): number {
  return db.transaction(() => {
    db.run(
      `INSERT INTO factory_order
       (id, project, title, description, priority, hold, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        order.id,
        order.project,
        order.title,
        order.description ?? null,
        order.priority ?? "unset",
        order.hold ?? null,
        at,
        at,
      ],
    );
    return appendOrderEventInTransaction(db, order.id, { kind: "queued", worker }, at);
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
    // Made before the claim is written, and inside the same transaction, so a claim
    // that cannot get a worktree writes no claim — reusing one already there is how
    // a failed order is taken again in place.
    createWorktree(orderId, cwd);
    db.run(
      `UPDATE factory_order SET run_id = ?, session_id = ?, station = ?,
         status = 'working', claimed_at = ?, updated_at = ? WHERE id = ?`,
      [claim.runId, claim.sessionId ?? null, claim.station ?? null, at, at, orderId],
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
  return db.transaction(() => {
    const event = appendOrderEventInTransaction(db, orderId, { kind: "moved", worker, station }, at);
    db.run("UPDATE factory_order SET station = ?, run_id = NULL, session_id = NULL WHERE id = ?", [
      station,
      orderId,
    ]);
    return event;
  })();
}

/** Current state rather than history: nothing has wanted to read back what an order
 *  used to be ranked at, and a row that wants one is its own change. */
export function setOrderPriority(db: Database, orderId: string, priority: OrderPriority): void {
  const result = db.run("UPDATE factory_order SET priority = ?, updated_at = ? WHERE id = ?", [
    priority,
    now(),
    orderId,
  ]);
  if (result.changes !== 1) throw new Error(`order not found: ${orderId}`);
}

export function setOrderHold(db: Database, orderId: string, hold: string | null): void {
  const result = db.run("UPDATE factory_order SET hold = ?, updated_at = ? WHERE id = ?", [
    hold,
    now(),
    orderId,
  ]);
  if (result.changes !== 1) throw new Error(`order not found: ${orderId}`);
}

/**
 * The owner's decision that an order will not be built, kept as a status rather than a
 * delete: why an order was not built is worth finding later, and a deletion is the one write
 * this record cannot hold. What it is refused on is `assertDroppable`.
 */
export function dropOrder(db: Database, orderId: string, reason: string, worker: string, at = now()): number {
  return db.transaction(() =>
    appendOrderEventInTransaction(db, orderId, { kind: "dropped", worker, status: "dropped", reason }, at),
  )();
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
  const order = db.query("SELECT status FROM factory_order WHERE id = ?").get(orderId) as {
    status: OrderStatus;
  } | null;
  if (!order) throw new Error(`order not found: ${orderId}`);
  if (isTerminalOrderStatus(order.status)) {
    throw new Error(`order ${orderId} is already ${order.status}`);
  }
  if (event.kind === "dropped") {
    assertDroppable(db, orderId);
  } else if (event.kind !== "queued" && event.kind !== "claimed") {
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
        hold_type, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

export function recordOrderFile(db: Database, orderId: string, file: OrderFile, at = now()): void {
  assertOrderBuilding(db, orderId);
  db.run(
    "INSERT INTO factory_order_file (order_id, path, added, removed, recorded_at) VALUES (?, ?, ?, ?, ?)",
    [orderId, file.path, file.added ?? null, file.removed ?? null, at],
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

export type ReviewRound = { id: number; round: number; reviewer: string };

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
    return appendOrderEventInTransaction(db, row.order_id, { kind: "review_closed", worker, reviewId }, at);
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
    .query<{ id: number; reviewer: string }, [string]>(
      "SELECT id, reviewer FROM factory_order_review WHERE order_id = ? AND closed_at IS NULL",
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
    appendOrderEventInTransaction(db, orderId, { kind: "plan_submitted", worker, planId }, at);
    return planId;
  })();
}

export function approveOrderPlan(db: Database, orderId: string, worker: string, at = now()): void {
  assertOrderWorking(db, orderId);
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(worker)?.role;
  if (role !== "operator")
    throw new PlanApprovalRefused("worker_not_operator", `worker ${worker} is not an operator`);
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
  appendOrderEvent(db, orderId, { kind: "plan_approved", worker, planId: plan.id }, at);
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
  return withLock(() => shipToTrunk(worktree, orderId, shas), env);
}
