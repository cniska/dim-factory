import type { Database } from "bun:sqlite";
import { version } from "../package.json";
import { invariant } from "./assert";
import { readConfig, type UserConfig } from "./config";
import { writeTransaction } from "./db";
import {
  admitOperator,
  admitWork,
  fold,
  type LeadingAct,
  leadingEntry,
  nextOf,
  type OperatorAct,
  type OrderState,
  operatorOf,
  orderIdOf,
} from "./order";
import {
  type Actor,
  Detailed,
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
  appendEntries(db, order, [{ seq, at: new Date().toISOString(), by, ...Detailed.parse(detailed) }]);
  return seq;
}

type Acted = { readonly seq: number; readonly by: Acting; readonly admitted: OrderState };

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
    const admission = admitOperator(state, by, operatorAct, liveRun(db, order, caller.running));
    if (admission.kind === "refused") throw admission.refusal;
    const seq = append(db, order, state.lastSeq + 1, actorOf(admission.by), later(state));
    return { seq, by: admission.by, admitted: state };
  });
}

export type ProjectSetup = {
  readonly root: string;
  readonly branch: string;
  readonly config: UserConfig;
};

export function projectSetup(db: Database, project: string, cwd: string): ProjectSetup {
  const checkout = checkoutOf(db, project, cwd);
  if (checkout === null) throw refuseOrder("no_checkout", { project });
  const branch = defaultBranch(checkout.root);
  if (branch === null) throw refuseOrder("no_default_branch", { checkout: checkout.root });
  return { root: checkout.root, branch, config: readConfig({ root: checkout.root, at: branch }) };
}

export type NewOrder = {
  readonly title: string;
  readonly description: string;
  readonly project: string | undefined;
};

export function addOrder(db: Database, caller: Caller, fields: NewOrder): string {
  const project = fields.project ?? checkoutAt(caller.cwd)?.project;
  if (project === undefined) throw refuseWorker("no_project", { cwd: caller.cwd });
  projectSetup(db, project, caller.cwd);
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
  readonly by: Acting;
  readonly cause: number;
  readonly created: boolean;
  readonly state: OrderState;
};

export function startRun(
  db: Database,
  order: string,
  caller: Caller,
  base: string,
  leading: LeadingAct,
): StartedRun {
  return writeTransaction(db, () => {
    const acted = act(db, order, caller, { kind: leading.kind }, (state) => leadingEntry(state, leading));
    const created = acted.admitted.head === null;
    if (created) recordFactory(db, order, acted.seq, { action: "workspace_created", details: { base } });
    const { state } = loadOrder(db, order);
    insertRun(db, order, state.phase.kind === "ship" ? "ship" : "station", caller.self);
    return { by: acted.by, cause: acted.seq, created, state };
  });
}

export function markHarness(db: Database, order: string, harness: ProcessId): void {
  invariant(setRunHarness(db, order, harness), `order ${order}'s run is on record while its turn starts`);
}

export function endRun(db: Database, order: string): void {
  deleteRun(db, order);
}

export function recordWork(
  db: Database,
  order: string,
  acting: Acting,
  station: Station,
  later: (state: OrderState) => Later,
): number {
  return writeTransaction(db, () => {
    const { state } = loadOrder(db, order);
    const admission = admitWork(state, acting, station);
    if (admission.kind === "refused") throw admission.refusal;
    return append(db, order, state.lastSeq + 1, actorOf(admission.by), later(state));
  });
}

export function recordVerdict(
  db: Database,
  order: string,
  cause: number,
  station: Station,
  later: Later,
): void {
  writeTransaction(db, () => {
    const { state } = loadOrder(db, order);
    const { phase } = state;
    if (state.status !== "running" || phase.kind !== "run" || phase.station !== station) {
      throw refuseOrder("not_next_step", { order, next: nextOf(phase) });
    }
    append(db, order, state.lastSeq + 1, { kind: "factory", version, cause }, later);
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
