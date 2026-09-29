import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { recordOrderEnvironment } from "./order-evidence";
import { appendOrderEventInTransaction, now } from "./order-ledger";
import { assertOrderQueued, type NewOrder } from "./order-status";
import { assertOperator } from "./worker";
import { createWorktree, validateWorktreeBranch } from "./worktree";

export function queueOrder(db: Database, order: NewOrder, worker: string, at = now()): number {
  validateWorktreeBranch(order.id);
  return writeTransaction(db, () => {
    assertOperator(db, worker, "queue an order");
    db.run(
      `INSERT INTO factory_order
       (id, project, title, line, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [order.id, order.project, order.title, order.line, order.description ?? null, at, at],
    );
    return appendOrderEventInTransaction(db, order.id, { kind: "queued", worker }, at);
  });
}

export function startOrder(
  db: Database,
  orderId: string,
  operator: string,
  at = now(),
  cwd: string = process.cwd(),
): number {
  return writeTransaction(db, () => {
    assertOrderQueued(db, orderId, "started");
    assertOperator(db, operator, "start an order");
    const { setup } = createWorktree(orderId, cwd);
    const started = appendOrderEventInTransaction(db, orderId, { kind: "started", worker: operator }, at);
    if (setup) recordOrderEnvironment(db, orderId, setup, at);
    return started;
  });
}

export function dropOrder(db: Database, orderId: string, reason: string, worker: string, at = now()): number {
  if (reason.trim() === "") throw new Error("a drop reason must not be empty");
  return writeTransaction(db, () => {
    assertOperator(db, worker, "drop an order");
    return appendOrderEventInTransaction(db, orderId, { kind: "dropped", worker, reason }, at);
  });
}
