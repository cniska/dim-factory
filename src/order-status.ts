import type { Database } from "bun:sqlite";
import type { EvidenceReference, OrderEventKind } from "./order-events";
import type { OrderLine } from "./order-line";
import type { Station } from "./station";

export const ORDER_STATUSES = ["queued", "active", "done", "dropped"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function orderStatusSql(orderId: string): string {
  const has = (kind: OrderEventKind) =>
    `EXISTS (SELECT 1 FROM factory_order_event s WHERE s.order_id = ${orderId} AND s.kind = '${kind}')`;
  return `CASE WHEN ${has("dropped")} THEN 'dropped' WHEN ${has("shipped")} THEN 'done'
               WHEN ${has("started")} THEN 'active' ELSE 'queued' END`;
}

export const ORDER_PRIORITIES = ["urgent", "high", "medium", "low", "unset"] as const;

export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

export type Order = {
  id: string;
  project: string;
  title: string;
  line?: OrderLine;
  description?: string;
  priority?: OrderPriority;
  provenance?: EvidenceReference;
};

export type OrderEvent = {
  kind: OrderEventKind;
  worker?: string;
  sessionId?: string;
  station?: Station;
  commitSha?: string;
  checkId?: number;
  reviewId?: number;
  findingId?: number;
  answerId?: number;
  artifactId?: number;
  reason?: string;
  evidence?: EvidenceReference;
  ts?: string;
};

export type OrderNotDoneCode =
  | "order_not_checked"
  | "order_not_queued"
  | "order_held_by_run"
  | "build_artifact_before_final_slice";

export class OrderNotDone extends Error {
  constructor(
    readonly code: OrderNotDoneCode,
    message: string,
  ) {
    super(message);
  }
}

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return status === "done" || status === "dropped";
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
  if (status !== "queued") {
    throw new OrderNotDone(
      "order_not_queued",
      `order ${orderId} is ${status} and only a queued order can be ${act}`,
    );
  }
}

export function assertOrderActive(db: Database, orderId: string): void {
  const status = orderStatus(db, orderId);
  if (status === "active") return;
  throw new Error(
    status === "queued" ? `order ${orderId} is not started` : `order ${orderId} is already ${status}`,
  );
}
