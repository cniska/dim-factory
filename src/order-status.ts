import type { Database } from "bun:sqlite";
import type { EvidenceReference, OrderEventKind } from "./order-events";
import type { OrderLine } from "./order-line";
import type { Station } from "./station";

export const ORDER_STATUSES = ["queued", "working", "completed", "dropped"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUSES_SQL = ORDER_STATUSES.map((status) => `'${status}'`).join(",");

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
  | "build_artifact_before_final_slice"
  | "build_revision_head_mismatch";

export class OrderNotDone extends Error {
  constructor(
    readonly code: OrderNotDoneCode,
    message: string,
  ) {
    super(message);
  }
}

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ["completed", "dropped"];

const terminalStatuses = new Set<OrderStatus>(TERMINAL_ORDER_STATUSES);

export function assertOrderQueued(db: Database, orderId: string, act: string): void {
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

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return terminalStatuses.has(status);
}

export function orderStatus(db: Database, orderId: string): OrderStatus {
  const order = db.query("SELECT status FROM factory_order WHERE id = ?").get(orderId) as {
    status: OrderStatus;
  } | null;
  if (!order) throw new Error(`order not found: ${orderId}`);
  return order.status;
}

export function assertOrderWorking(db: Database, orderId: string): void {
  const status = orderStatus(db, orderId);
  if (status === "working") return;
  throw new Error(
    status === "queued" ? `order ${orderId} is not started` : `order ${orderId} is already ${status}`,
  );
}
