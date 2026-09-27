import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { assertOperator } from "./factory-operator";
import { FactoryStopError, liveStop } from "./factory-stop";
import { appendOrderEvent, appendOrderEventInTransaction, now } from "./order-ledger";
import { assertOrderQueued, type Order, type OrderPriority } from "./order-status";
import { createWorktree, validateWorktreeBranch } from "./wt-command";

export function queueOrder(db: Database, order: Order, worker: string, at = now()): number {
  validateWorktreeBranch(order.id);
  return writeTransaction(db, () => {
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
    return appendOrderEventInTransaction(db, orderId, { kind: "started", worker: operator }, at);
  });
}

export function setOrderPriority(
  db: Database,
  orderId: string,
  priority: OrderPriority,
  worker?: string,
  at = now(),
): void {
  writeTransaction(db, () => {
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
  });
}

export function dropOrder(db: Database, orderId: string, reason: string, worker: string, at = now()): number {
  if (reason.trim() === "") throw new Error("a drop reason must not be empty");
  return appendOrderEvent(db, orderId, { kind: "dropped", worker, reason }, at);
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
