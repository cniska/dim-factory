import { CodedError } from "./coded-error";
import type { OrderStatus } from "./order-status";
import type { Station } from "./station";

export type OrderArtifact = {
  id: number;
  kind: Station;
  revision: number;
  headSha: string | null;
  reviewId: number | null;
  approved: boolean;
  returned: boolean;
};

export type OrderSliceRecord = { id: number; artifactId: number; ordinal: number; done: boolean };

export type OrderCommitRecord = { id: number; sha: string; retires: string | null; shipRunId: number | null };

export type OrderShipRunRecord = {
  id: number;
  outcome: string;
  oldHead: string | null;
  patchEqual: number | null;
};

export type OrderCheckRecord = { id: number; headSha: string | null; exitCode: number };

export type OrderReviewRecord = { id: number; headSha: string };

export type OrderFindingRecord = { id: number; reviewId: number; answered: boolean };

export type Order = {
  id: string;
  status: OrderStatus;
  artifacts: OrderArtifact[];
  slices: OrderSliceRecord[];
  commits: OrderCommitRecord[];
  shipRuns: OrderShipRunRecord[];
  checks: OrderCheckRecord[];
  reviews: OrderReviewRecord[];
  findings: OrderFindingRecord[];
};

const MESSAGES = {
  not_next: (m: { orderId: string; waitsOn: string; act: string }) =>
    `order ${m.orderId} waits on ${m.waitsOn}, so it cannot ${m.act}`,
  order_terminal: (m: { orderId: string; status: string; act: string }) =>
    `order ${m.orderId} is ${m.status}, so it cannot ${m.act}`,
  order_not_queued: (m: { orderId: string; status: string; act: string }) =>
    `order ${m.orderId} is ${m.status} and only a queued order can be ${m.act}`,
  order_held_by_run: (m: { orderId: string; worker: string; runId: string; act: string }) =>
    `order ${m.orderId} is being worked by ${m.worker} under ${m.runId}, so it cannot ${m.act}`,
  order_not_checked: (m: { orderId: string }) =>
    `order ${m.orderId} has no check that passed at its last commit`,
  no_final_build_turn: (m: { orderId: string }) => `order ${m.orderId} has no active final build turn`,
  build_artifact_before_final_slice: (m: { orderId: string }) =>
    `order ${m.orderId} must finish its final slice before recording a Build artifact`,
};

export type OrderErrorCode = keyof typeof MESSAGES;
export type OrderErrorMeta<Code extends OrderErrorCode> = Parameters<(typeof MESSAGES)[Code]>[0];

export function fail<Code extends OrderErrorCode>(
  code: Code,
  meta: OrderErrorMeta<Code>,
): CodedError<Code, OrderErrorMeta<Code>> {
  const message = (MESSAGES[code] as (m: OrderErrorMeta<Code>) => string)(meta);
  return new CodedError(code, message, meta);
}
