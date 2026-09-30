import type { Database } from "bun:sqlite";
import { version } from "../package.json";
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
  type RunKind,
  refuseOrder,
  type Station,
} from "./order-contract";
import { appendEntries, deleteRun, insertRun, readLog, runOf, setRunHarness } from "./order-store";
import { type OrderView, orderView, workerNamesOf } from "./order-view";
import { workspaceDir } from "./paths";
import { checkoutAt, checkoutOf, defaultBranch } from "./project";
import { isRunning } from "./worker";
import { type Acting, type Caller, type ProcessId, refuseWorker } from "./worker-contract";
import { actingOperator, workersNamed } from "./worker-ops";

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

function liveRun(db: Database, order: string, running: readonly ProcessId[]): RunKind | null {
  const run = runOf(db, order);
  return run !== null && isRunning(run.process, running) ? run.kind : null;
}

const actorOf = (acting: Acting): Actor => ({
  kind: "worker",
  worker: acting.worker.name,
  session: acting.session.id,
});

function append(db: Database, order: string, seq: number, by: Actor, detailed: Detailed): number {
  appendEntries(db, order, [{ seq, at: new Date().toISOString(), by, ...detailed }]);
  return seq;
}

function act(
  db: Database,
  order: string,
  caller: Caller,
  operatorAct: OperatorAct,
  later: (state: OrderState) => Later,
): Acted {
  return writeTransaction(db, () => {
    const { state } = loadOrder(db, order);
    const by = actingOperator(db, caller, state.project);
    const admission = admit(state, by, operatorAct, liveRun(db, order, caller.running));
    if (admission.kind === "refused") throw admission.refusal;
    return {
      seq: append(db, order, state.lastSeq + 1, actorOf(admission.by), later(state)),
      by: admission.by,
    };
  });
}

type Acted = { readonly seq: number; readonly by: Acting };

export type NewOrder = {
  readonly title: string;
  readonly description: string;
  readonly project: string | undefined;
  readonly cwd: string;
};

export function addOrder(db: Database, caller: Caller, fields: NewOrder): string {
  const project = fields.project ?? checkoutAt(fields.cwd)?.project;
  if (project === undefined) throw refuseWorker("no_project", { cwd: fields.cwd });
  const checkout = checkoutOf(db, project, fields.cwd);
  if (checkout === null) throw refuseOrder("no_checkout", { project });
  const branch = defaultBranch(checkout.root);
  if (branch === null) throw refuseOrder("no_default_branch", { checkout: checkout.root });
  readConfig({ root: checkout.root, at: branch });
  return writeTransaction(db, () => {
    const admission = operatorOf(actingOperator(db, caller, project), project);
    if (admission.kind === "refused") throw admission.refusal;
    const order = orderIdOf(crypto.getRandomValues(new Uint8Array(ORDER_ID_LENGTH)));
    append(db, order, 1, actorOf(admission.by), {
      action: "order_added",
      details: { title: fields.title, description: fields.description, project },
    });
    return order;
  });
}

export function updateOrder(
  db: Database,
  order: string,
  caller: Caller,
  fields: { readonly title?: string; readonly description?: string },
): void {
  act(db, order, caller, { kind: "update" }, (state) => ({
    action: "order_updated",
    details: { title: fields.title ?? state.title, description: fields.description ?? state.description },
  }));
}

export function cancelOrder(db: Database, order: string, caller: Caller, reason: string): void {
  act(db, order, caller, { kind: "cancel" }, () => ({ action: "order_cancelled", details: { reason } }));
}

export function orderState(db: Database, order: string): OrderState {
  return loadOrder(db, order).state;
}

export type StartedRun = {
  readonly state: OrderState;
  readonly by: Acting;
  readonly cause: number;
  readonly created: boolean;
};

export function startRun(db: Database, order: string, caller: Caller, base: string): StartedRun {
  return writeTransaction(db, () => {
    const { seq: cause, by } = act(db, order, caller, { kind: "run" }, () => ({
      action: "order_run",
      details: {},
    }));
    insertRun(db, order, "station", caller.self);
    const created = loadOrder(db, order).state.head === null;
    if (created) recordFactory(db, order, cause, { action: "workspace_created", details: { base } });
    return { state: loadOrder(db, order).state, by, cause, created };
  });
}

export function markHarness(db: Database, order: string, harness: ProcessId): void {
  setRunHarness(db, order, harness);
}

export function endRun(db: Database, order: string): void {
  deleteRun(db, order);
}

export function recordWork(
  db: Database,
  order: string,
  acting: Acting,
  station: Station,
  later: Later,
): void {
  writeTransaction(db, () => {
    const { state } = loadOrder(db, order);
    const admission = admit(state, acting, { kind: "work", station }, null);
    if (admission.kind === "refused") throw admission.refusal;
    append(db, order, state.lastSeq + 1, actorOf(admission.by), later);
  });
}

export function recordFactory(db: Database, order: string, cause: number, later: Later): void {
  writeTransaction(db, () => {
    const { state } = loadOrder(db, order);
    append(db, order, state.lastSeq + 1, { kind: "factory", version, cause }, later);
  });
}

export function showOrder(db: Database, order: string): OrderView {
  const { state, log } = loadOrder(db, order);
  return orderView(state, log, workersNamed(db, workerNamesOf(log)), workspaceDir(state.project, order));
}
