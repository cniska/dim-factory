import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { writeTransaction } from "./db";
import { admit, fold, mayAdd, type OperatorAct, type OrderState, orderIdOf } from "./order";
import {
  type Actor,
  type Later,
  type LaterEntry,
  type LogEntry,
  ORDER_ID_LENGTH,
  refuseOrder,
} from "./order-contract";
import { appendEntries, readLog } from "./order-store";
import { type OrderView, orderView, workerNamesOf } from "./order-view";
import { workspaceDir } from "./paths";
import type { Acting } from "./worker-contract";
import { workersNamed } from "./worker-ops";

export type LoadedOrder = { readonly state: OrderState; readonly log: readonly LogEntry[] };

export function loadOrder(db: Database, order: string): LoadedOrder {
  const log = readLog(db, order);
  const [first, ...rest] = log;
  if (first === undefined) throw refuseOrder("no_order", { order });
  invariant(first.action === "order_added", `order ${order}'s log starts with order_added`);
  const later = rest.filter((entry): entry is LaterEntry => entry.action !== "order_added");
  invariant(later.length === rest.length, `order ${order} is added once`);
  return { state: fold(order, first, later), log };
}

const actorOf = (acting: Acting): Actor => ({
  kind: "worker",
  worker: acting.worker.name,
  session: acting.session.id,
});

export function recordEntry(db: Database, state: OrderState, by: Actor, later: Later): LogEntry {
  const entry = { seq: state.lastSeq + 1, at: new Date().toISOString(), by, ...later };
  appendEntries(db, state.id, [entry]);
  return entry;
}

export function addOrder(
  db: Database,
  by: Acting | null,
  details: { readonly title: string; readonly description: string; readonly project: string },
): string {
  const admission = mayAdd(by, details.project);
  if ("refused" in admission) throw admission.refused;
  const order = orderIdOf(crypto.getRandomValues(new Uint8Array(ORDER_ID_LENGTH)));
  appendEntries(db, order, [
    { seq: 1, at: new Date().toISOString(), by: actorOf(admission.admitted), action: "order_added", details },
  ]);
  return order;
}

export function takeAct(
  db: Database,
  order: string,
  by: Acting | null,
  act: OperatorAct,
  later: (state: OrderState) => Later,
): LogEntry {
  return writeTransaction(db, () => {
    const { state } = loadOrder(db, order);
    const admission = admit(state, by, act);
    if ("refused" in admission) throw admission.refused;
    return recordEntry(db, state, actorOf(admission.admitted), later(state));
  });
}

export function viewOf(db: Database, order: string): OrderView {
  const { state, log } = loadOrder(db, order);
  return orderView(state, log, workersNamed(db, workerNamesOf(log)), workspaceDir(state.project, order));
}
