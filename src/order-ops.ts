import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { readConfig } from "./config";
import { writeTransaction } from "./db";
import { admit, fold, type OperatorAct, type OrderState, operatorOf, orderIdOf } from "./order";
import {
  type Actor,
  type Detailed,
  type Later,
  type LaterEntry,
  type LogEntry,
  ORDER_ID_LENGTH,
  refuseOrder,
} from "./order-contract";
import { appendEntries, readLog } from "./order-store";
import { type OrderView, orderView, workerNamesOf } from "./order-view";
import { workspaceDir } from "./paths";
import { checkoutAt, defaultBranch, lastCheckoutOf } from "./project";
import { type Acting, refuseWorker } from "./worker-contract";
import { workersNamed } from "./worker-ops";

type LoadedOrder = { readonly state: OrderState; readonly log: readonly LogEntry[] };

function loadOrder(db: Database, order: string): LoadedOrder {
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

function append(db: Database, order: string, seq: number, by: Actor, detailed: Detailed): LogEntry {
  const entry = { seq, at: new Date().toISOString(), by, ...detailed };
  appendEntries(db, order, [entry]);
  return entry;
}

function act(
  db: Database,
  order: string,
  by: Acting | null,
  operatorAct: OperatorAct,
  later: (state: OrderState) => Later,
) {
  writeTransaction(db, () => {
    const { state } = loadOrder(db, order);
    const admission = admit(state, by, operatorAct);
    if (admission.kind === "refused") throw admission.refusal;
    append(db, order, state.lastSeq + 1, actorOf(admission.by), later(state));
  });
}

export type NewOrder = {
  readonly title: string;
  readonly description: string;
  readonly project: string | undefined;
  readonly cwd: string;
};

export function addOrder(db: Database, by: Acting | null, fields: NewOrder): string {
  const here = checkoutAt(fields.cwd);
  const project = fields.project ?? here?.project;
  if (project === undefined) throw refuseWorker("no_project", { cwd: fields.cwd });
  const checkout = here?.project === project ? here : lastCheckoutOf(db, project);
  if (checkout === null) throw refuseOrder("no_checkout", { project });
  const branch = defaultBranch(checkout.root);
  if (branch === null) throw refuseOrder("no_default_branch", { checkout: checkout.root });
  readConfig({ root: checkout.root, at: branch });
  const admission = operatorOf(by, project);
  if (admission.kind === "refused") throw admission.refusal;
  const order = orderIdOf(crypto.getRandomValues(new Uint8Array(ORDER_ID_LENGTH)));
  append(db, order, 1, actorOf(admission.by), {
    action: "order_added",
    details: { title: fields.title, description: fields.description, project },
  });
  return order;
}

export function updateOrder(
  db: Database,
  order: string,
  by: Acting | null,
  fields: { readonly title?: string; readonly description?: string },
): void {
  act(db, order, by, { kind: "update" }, (state) => ({
    action: "order_updated",
    details: { title: fields.title ?? state.title, description: fields.description ?? state.description },
  }));
}

export function cancelOrder(db: Database, order: string, by: Acting | null, reason: string): void {
  act(db, order, by, { kind: "cancel" }, () => ({ action: "order_cancelled", details: { reason } }));
}

export function showOrder(db: Database, order: string): OrderView {
  const { state, log } = loadOrder(db, order);
  return orderView(state, log, workersNamed(db, workerNamesOf(log)), workspaceDir(state.project, order));
}
