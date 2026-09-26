import type { Database } from "bun:sqlite";
import { assertOperator } from "./factory-operator";
import { FactoryStopError, liveStop } from "./factory-stop";
import { openAttempt } from "./order-attempt";
import { appendOrderEventInTransaction, now } from "./order-ledger";
import { closeOrderReview, ReviewNotOpen } from "./order-review";
import { assertOrderQueued, assertOrderWorking, type Order, type OrderPriority } from "./order-status";
import { workerIsOver } from "./worker";
import { createWorktree } from "./wt-command";

export function queueOrder(db: Database, order: Order, worker: string, at = now()): number {
  return db.transaction(() => {
    db.run(
      `INSERT INTO factory_order
       (id, project, title, line, description, priority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        order.id,
        order.project,
        order.title,
        order.line ?? "feat",
        order.description ?? null,
        order.priority ?? "unset",
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

export function startOrder(
  db: Database,
  orderId: string,
  operator: string,
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
    assertOrderQueued(db, orderId, "started");
    assertOperator(db, operator, "start an order");
    createWorktree(orderId, cwd);
    return appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "started", worker: operator, status: "working" },
      at,
    );
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
    assertOrderWorking(db, orderId);
    const attempt = openAttempt(db, orderId);
    const attemptWorker = attempt?.worker;
    const station = attempt?.station;
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
        station,
        reason,
      },
      at,
      worktree,
    );
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "recovered", worker: operator, station, reason },
      at,
      worktree,
    );
  })();
}
