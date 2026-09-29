import { CodedError } from "./coded-error";

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
