import type { Database } from "bun:sqlite";
import { describeState, type OrderState, orderState } from "./order";
import { fail } from "./order-contract";
import { isTerminalOrderStatus, orderStatus } from "./order-status";
import type { Station } from "./station";

export type OrderAct = "plan" | "build" | "review" | "approve" | "return" | "ship";

const ENTERS: Record<Exclude<OrderAct, "return">, (state: OrderState) => boolean> = {
  plan: (state) => state.station === "plan" && state.next === "run",
  build: (state) => state.station === "build" && state.next === "run",
  review: (state) => state.station === "review" && state.next === "run",
  approve: (state) => state.next === "approve",
  ship: (state) => state.next === "ship",
};

const RETURNS_TO: Record<Station, (state: OrderState) => boolean> = {
  plan: (state) => state.station === "build" || (state.station === "plan" && state.next === "approve"),
  build: (state) => (state.station === "build" || state.station === "review") && state.next === "approve",
  review: (state) => state.station === "review" && state.next === "approve",
};

function admits(state: OrderState, act: OrderAct, to: Station | undefined): boolean {
  if (act !== "return") return ENTERS[act](state);
  const destination = to ?? state.station;
  return destination !== null && RETURNS_TO[destination](state);
}

export function assertNext(
  db: Database,
  orderId: string,
  act: "approve",
): Extract<OrderState, { next: "approve" }>;
export function assertNext(
  db: Database,
  orderId: string,
  act: "return",
  to?: Station,
): Extract<OrderState, { station: Station }>;
export function assertNext(db: Database, orderId: string, act: OrderAct, to?: Station): OrderState;
export function assertNext(db: Database, orderId: string, act: OrderAct, to?: Station): OrderState {
  const status = orderStatus(db, orderId);
  if (isTerminalOrderStatus(status)) throw fail("order_terminal", { orderId, status, act });
  const state = orderState(db, orderId);
  if (!admits(state, act, to)) throw fail("not_next", { orderId, waitsOn: describeState(state), act });
  return state;
}
