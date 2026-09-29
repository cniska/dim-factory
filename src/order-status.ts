import type { Database } from "bun:sqlite";
import { fail } from "./order-contract";
import type { EvidenceReference, OrderEventKind } from "./order-events";
import type { OrderLine } from "./order-line";

export const ORDER_STATUSES = ["queued", "running", "shipped", "dropped"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function orderStatusSql(orderId: string): string {
  const has = (kind: OrderEventKind) =>
    `EXISTS (SELECT 1 FROM factory_order_event s WHERE s.order_id = ${orderId} AND s.kind = '${kind}')`;
  const landed = `EXISTS (SELECT 1 FROM factory_order_ship_run r WHERE r.order_id = ${orderId} AND r.outcome = 'landed')`;
  return `CASE WHEN ${has("dropped")} THEN 'dropped' WHEN ${landed} THEN 'shipped'
               WHEN ${has("started")} THEN 'running' ELSE 'queued' END`;
}

export const ORDER_PRIORITIES = ["urgent", "high", "medium", "low", "unset"] as const;

export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

export type NewOrder = {
  id: string;
  project: string;
  title: string;
  line?: OrderLine;
  description?: string;
  priority?: OrderPriority;
  provenance?: EvidenceReference;
};

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return status === "shipped" || status === "dropped";
}

export function orderStatus(db: Database, orderId: string): OrderStatus {
  const order = db
    .query<{ status: OrderStatus }, [string]>(
      `SELECT ${orderStatusSql("o.id")} AS status FROM factory_order o WHERE o.id = ?`,
    )
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  return order.status;
}

export function assertOrderQueued(db: Database, orderId: string, act: string): void {
  const status = orderStatus(db, orderId);
  if (status !== "queued") throw fail("order_not_queued", { orderId, status, act });
}

export function assertOrderRunning(db: Database, orderId: string): void {
  const status = orderStatus(db, orderId);
  if (status !== "running") throw fail("order_not_running", { orderId, status });
}
