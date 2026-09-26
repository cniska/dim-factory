import type { Database } from "bun:sqlite";
import type { EvidenceReference, OrderEventKind } from "./factory-events";
import { workerIsOver } from "./factory-worker";
import type { OrderLine } from "./order-line";
import type { Station } from "./station";

export const ORDER_STATUSES = ["queued", "working", "completed", "dropped"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const APPROVAL_HOLD = "approval";

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
  hold?: string;
  provenance?: EvidenceReference;
};

export type OrderClaim = {
  runId: string;
  sessionId?: string;
  station?: Station;
  operatorWorker: string;
  providerSessionId?: string;
  harness?: string;
  model?: string;
  tier?: string;
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
  | "order_not_reviewing"
  | "plan_not_approved"
  | "build_not_approved"
  | "build_not_final"
  | "build_artifact_before_final_slice"
  | "build_artifact_missing"
  | "build_revision_head_mismatch"
  | "artifact_revision_required"
  | "review_not_approved";

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
      | "finding_unsettled"
      | "ruling_pending"
      | "review_already_approved",
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

export function liveHolder(db: Database, orderId: string): { worker: string; runId: string } | null {
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

export function assertDroppable(db: Database, orderId: string): void {
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

export function assertOrderWorking(db: Database, orderId: string): void {
  const status = orderStatus(db, orderId);
  if (status === "working") return;
  throw new Error(
    status === "queued" ? `order ${orderId} is not claimed` : `order ${orderId} is already ${status}`,
  );
}

const NOT_AT_STATION = {
  plan: "order_not_planning",
  build: "order_not_building",
  review: "order_not_reviewing",
} as const satisfies Record<Station, OrderNotDoneCode>;

export function assertOrderAtStation(db: Database, orderId: string, station: Station, act: string): void {
  const at = db
    .query<{ station: Station | null }, [string]>("SELECT station FROM factory_order WHERE id = ?")
    .get(orderId)?.station;
  if (at === station) return;
  throw new OrderNotDone(
    NOT_AT_STATION[station],
    `order ${orderId} is at ${at ?? "no station"} and must move to ${station} before it can ${act}`,
  );
}
