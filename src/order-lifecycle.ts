import type { Database } from "bun:sqlite";
import { FactoryStopError, liveStop } from "./factory-stop";
import {
  appendOrderEventInTransaction,
  now,
  recordAttemptFinish,
  setOrderHoldInTransaction,
} from "./order-ledger";
import { closeOrderReview, ReviewNotOpen } from "./order-review";
import {
  assertOrderQueued,
  liveHolder,
  type Order,
  type OrderClaim,
  type OrderPriority,
  type OrderStatus,
} from "./order-status";
import type { Station } from "./station";
import { workerIsOver } from "./worker";
import { createWorktree } from "./wt-command";

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

export function moveOrder(
  db: Database,
  orderId: string,
  station: Station,
  worker: string,
  at = now(),
): number {
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

export function dropOrder(db: Database, orderId: string, reason: string, worker: string, at = now()): number {
  if (reason.trim() === "") throw new Error("a drop reason must not be empty");
  return db.transaction(() => {
    return appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "dropped", worker, status: "dropped", reason },
      at,
    );
  })();
}

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
      .query<{ run_id: string | null; station: Station | null }, [string]>(
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
    const openReview = db
      .query<{ id: number; reviewer: string | null }, [string]>(
        `SELECT r.id, coalesce(r.reviewer, a.accepted_worker) AS reviewer
         FROM factory_order_review r
         LEFT JOIN factory_worker_assignment a ON a.id = r.assignment_id
         WHERE r.order_id = ? AND r.closed_at IS NULL`,
      )
      .get(orderId);
    if (openReview?.reviewer && !workerIsOver(db, openReview.reviewer)) {
      throw new ReviewNotOpen(
        "review_running",
        `review ${openReview.id} is still being read by ${openReview.reviewer}, so recovery leaves it open`,
      );
    }
    if (openReview) closeOrderReview(db, openReview.id, "aborted", operator, at, reason);
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
