import type { Database } from "bun:sqlite";
import { version } from "../package.json";
import { invariant } from "./assert";
import { readConfig, type UserConfig } from "./config";
import { writeTransaction } from "./db";
import { type Identity, identityOf } from "./git-tree";
import {
  admitOperator,
  asOperator,
  fold,
  type OperatorAct,
  type OrderState,
  operatorEntry,
  orderIdOf,
  runKindOf,
  type WorkBy,
  workRefusal,
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
import { type Env, workspaceDir } from "./paths";
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

type Appended = { readonly seq: number; readonly state: OrderState };

function append(db: Database, order: string, by: Actor, detailed: Detailed): Appended {
  const seq = loadOrder(db, order).state.lastSeq + 1;
  appendEntries(db, order, [{ seq, at: new Date().toISOString(), by, ...Detailed.parse(detailed) }]);
  return { seq, state: loadOrder(db, order).state };
}

type Acted = Appended & { readonly by: Acting; readonly admitted: OrderState };

function act(db: Database, order: string, caller: Caller, operatorAct: OperatorAct): Acted {
  return writeTransaction(db, () => {
    const { state } = loadOrder(db, order);
    const by = actingOperator(db, caller, state.project);
    const admission = admitOperator(state, by, operatorAct.kind, liveRun(db, order, caller.running));
    if (admission.kind === "refused") throw admission.refusal;
    const appended = append(db, order, actorOf(admission.by), operatorEntry(state, operatorAct));
    return { ...appended, by: admission.by, admitted: state };
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

export function ownerIdentity(checkout: string, env: Env): Identity {
  const identity = identityOf(checkout, env);
  if (identity === null) throw refuseOrder("no_git_identity", { checkout });
  return identity;
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
    const admission = asOperator(actingOperator(db, caller, project), project);
    if (admission.kind === "refused") throw admission.refusal;
    const order = orderIdOf(crypto.getRandomValues(new Uint8Array(ORDER_ID_LENGTH)));
    appendEntries(db, order, [
      {
        seq: 1,
        at: new Date().toISOString(),
        by: actorOf(admission.by),
        action: "order_added",
        details: { title: fields.title, description: fields.description, project },
      },
    ]);
    return order;
  });
}

export function updateOrder(
  db: Database,
  order: string,
  caller: Caller,
  fields: { readonly title?: string; readonly description?: string },
): void {
  act(db, order, caller, { kind: "update", ...fields });
}

export type Cancelled = { readonly state: OrderState; readonly harness: ProcessId | null };

export function recordCancel(db: Database, order: string, caller: Caller, reason: string): Cancelled {
  return writeTransaction(db, () => {
    const { state } = act(db, order, caller, { kind: "cancel", reason });
    const run = runOf(db, order);
    const live = run?.harness ?? null;
    return { state, harness: live !== null && isRunning(live, caller.running) ? live : null };
  });
}

export function orderState(db: Database, order: string): OrderState {
  return loadOrder(db, order).state;
}

export type StartedRun = {
  readonly by: Acting;
  readonly cause: number;
  readonly created: boolean;
  readonly state: OrderState;
  readonly orphan: ProcessId | null;
};

function clearLostRun(db: Database, order: string, running: readonly ProcessId[]): ProcessId | null {
  const lost = runOf(db, order);
  if (lost === null) return null;
  deleteRun(db, order);
  return lost.harness !== null && isRunning(lost.harness, running) ? lost.harness : null;
}

export function startRun(
  db: Database,
  order: string,
  caller: Caller,
  base: string,
  leading: OperatorAct,
): StartedRun {
  return writeTransaction(db, () => {
    const acted = act(db, order, caller, leading);
    const created = acted.admitted.head === null;
    const state = created
      ? append(
          db,
          order,
          { kind: "factory", version, cause: acted.seq },
          {
            action: "workspace_created",
            details: { base },
          },
        ).state
      : acted.state;
    const orphan = clearLostRun(db, order, caller.running);
    insertRun(db, order, runKindOf(state.phase), caller.self);
    return { by: acted.by, cause: acted.seq, created, state, orphan };
  });
}

export function markHarness(db: Database, order: string, harness: ProcessId): void {
  invariant(setRunHarness(db, order, harness), `order ${order}'s run is on record while its turn starts`);
}

export function endRun(db: Database, order: string): void {
  deleteRun(db, order);
}

function recordAt(
  db: Database,
  order: string,
  station: Station,
  by: WorkBy,
  later: (state: OrderState) => Later,
) {
  return writeTransaction(db, () => {
    const { state } = loadOrder(db, order);
    const refusal = workRefusal(state, station, by);
    if (refusal !== null) throw refusal;
    return append(db, order, actorBy(by), later(state));
  });
}

const actorBy = (by: WorkBy): Actor =>
  by.kind === "worker" ? actorOf(by.acting) : { kind: "factory", version, cause: by.cause };

export function recordWork(
  db: Database,
  order: string,
  acting: Acting,
  station: Station,
  later: (state: OrderState) => Later,
): Appended {
  return recordAt(db, order, station, { kind: "worker", acting }, later);
}

export function recordVerdict(
  db: Database,
  order: string,
  cause: number,
  station: Station,
  later: Later,
): Appended {
  return recordAt(db, order, station, { kind: "factory", cause }, () => later);
}

export function recordAs(db: Database, order: string, by: WorkBy, later: Later): Appended {
  return writeTransaction(db, () => append(db, order, actorBy(by), later));
}

export function showOrder(db: Database, order: string): OrderView {
  const { state, log } = loadOrder(db, order);
  return orderView(state, log, workersNamed(db, workerNamesOf(log)), workspaceDir(state.project, order));
}
