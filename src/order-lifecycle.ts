import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { assertOperator } from "./factory-operator";
import { fail } from "./order-contract";
import { recordOrderEnvironment } from "./order-evidence";
import { appendOrderEventInTransaction, now } from "./order-ledger";
import { assertOrderQueued, type NewOrder, type OrderPriority } from "./order-status";
import { createWorktree, validateWorktreeBranch } from "./worktree";

export function queueOrder(db: Database, order: NewOrder, worker: string, at = now()): number {
  validateWorktreeBranch(order.id);
  return writeTransaction(db, () => {
    assertOperator(db, worker, "queue an order");
    db.run(
      `INSERT INTO factory_order
       (id, project, title, line, description, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

export function setOrderPriority(
  db: Database,
  orderId: string,
  priority: OrderPriority,
  worker: string,
  at = now(),
): void {
  writeTransaction(db, () => {
    assertOperator(db, worker, "prioritize an order");
    const result = db.run("UPDATE factory_order SET priority = ?, updated_at = ? WHERE id = ?", [
      priority,
      at,
      orderId,
    ]);
    if (result.changes !== 1) throw fail("order_unknown", { orderId });
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "priority_changed", worker, evidence: { priority } },
      at,
    );
  });
}

export function dropOrder(db: Database, orderId: string, reason: string, worker: string, at = now()): number {
  if (reason.trim() === "") throw new Error("a drop reason must not be empty");
  return writeTransaction(db, () => {
    assertOperator(db, worker, "drop an order");
    return appendOrderEventInTransaction(db, orderId, { kind: "dropped", worker, reason }, at);
  });
}

export function amendOrder(
  db: Database,
  orderId: string,
  changes: { title?: string; description?: string },
  worker: string,
  at = now(),
): void {
  writeTransaction(db, () => {
    assertOperator(db, worker, "amend an order");
    assertOrderQueued(db, orderId, "amended");
    db.run(
      `UPDATE factory_order SET title = coalesce(?, title), description = coalesce(?, description),
         updated_at = ? WHERE id = ?`,
      [changes.title ?? null, changes.description ?? null, at, orderId],
    );
  });
}
