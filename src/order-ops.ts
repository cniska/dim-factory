import type { Database } from "bun:sqlite";
import { version } from "../package.json";
import { invariant } from "./assert";
import { readConfig, type UserConfig } from "./config";
import { writeTransaction } from "./db";
import { type Identity, identityOf } from "./git";
import {
  fold,
  type OrderState,
  operatorActRefusal,
  operatorEntry,
  operatorRefusal,
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
  type OperatorAct,
  ORDER_ID_LENGTH,
  type OrderView,
  type RunKind,
  refuseOrder,
  type Station,
} from "./order-contract";
import { appendEntry, deleteRun, insertRun, orderIds, readLog, runOf, setRunHarness } from "./order-store";
import { orderView, workerNamesOf } from "./order-view";
import { type Env, workspaceDir } from "./paths";
import { checkoutAt, checkoutOf, defaultBranch } from "./project";
import type { Trace } from "./trace-contract";
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

export function runAlive(db: Database, order: string, running: readonly ProcessId[]): boolean {
  return liveRun(db, order, running) !== null;
}

const actorOf = (acting: Acting): Actor => ({
  kind: "worker",
  worker: acting.worker.name,
  session: acting.session.id,
});

type Appended = { readonly seq: number; readonly state: OrderState };

function append(db: Database, order: string, by: Actor, detailed: Detailed): Appended {
  const seq = loadOrder(db, order).state.lastSeq + 1;
  appendEntry(db, order, { seq, ts: new Date().toISOString(), by, ...Detailed.parse(detailed) });
  return { seq, state: loadOrder(db, order).state };
}

type Acted = Appended & { readonly by: Acting; readonly admitted: OrderState };

function act(db: Database, order: string, caller: Caller, operatorAct: OperatorAct): Acted {
  return writeTransaction(db, () => {
    const { state } = loadOrder(db, order);
    const by = actingOperator(db, caller, state.project);
    const refusal = operatorActRefusal(state, by, operatorAct.kind, liveRun(db, order, caller.running));
    if (refusal !== null) throw refusal;
    const appended = append(db, order, actorOf(by), operatorEntry(state, operatorAct));
    return { ...appended, by, admitted: state };
  });
}

export type ProjectSetup = {
  readonly root: string;
  readonly branch: string;
  readonly config: UserConfig;
};

type ProjectCheckout = Omit<ProjectSetup, "config">;

export function projectCheckout(db: Database, project: string, cwd: string): ProjectCheckout {
  const checkout = checkoutOf(db, project, cwd);
  if (checkout === null) throw refuseOrder("no_checkout", { project });
  const branch = defaultBranch(checkout.root);
  if (branch === null) throw refuseOrder("no_default_branch", { checkout: checkout.root });
  return { root: checkout.root, branch };
}

export function projectSetup(db: Database, project: string, cwd: string): ProjectSetup {
  const { root, branch } = projectCheckout(db, project, cwd);
  return { root, branch, config: readConfig({ root, at: branch }) };
}

export function ownerIdentity(checkout: string, env: Env): Identity {
  const identity = identityOf(checkout, env);
  if (identity === null) throw refuseOrder("no_git_identity", { checkout });
  return identity;
}

type NewOrder = {
  readonly title: string;
  readonly description: string;
  readonly project: string | undefined;
};

export function addOrder(db: Database, caller: Caller, fields: NewOrder): string {
  const project = fields.project ?? checkoutAt(caller.cwd)?.project;
  if (project === undefined) throw refuseWorker("no_project", { cwd: caller.cwd });
  projectSetup(db, project, caller.cwd);
  return writeTransaction(db, () => {
    const by = actingOperator(db, caller, project);
    const refusal = operatorRefusal(by, project);
    if (refusal !== null) throw refusal;
    const order = orderIdOf(crypto.getRandomValues(new Uint8Array(ORDER_ID_LENGTH)));
    appendEntry(db, order, {
      seq: 1,
      ts: new Date().toISOString(),
      by: actorOf(by),
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
  act(db, order, caller, { kind: "update", ...fields });
}

export type Cancelled = {
  readonly state: OrderState;
  readonly cause: number;
  readonly harness: ProcessId | null;
};

export function recordCancel(
  trace: Trace,
  db: Database,
  order: string,
  caller: Caller,
  reason: string,
): Cancelled {
  return trace.step(
    "run_start",
    { act: "cancel" },
    () =>
      writeTransaction(db, () => {
        const { state, seq } = act(db, order, caller, { kind: "cancel", reason });
        const run = runOf(db, order);
        const live = run?.harness ?? null;
        return { state, cause: seq, harness: live !== null && isRunning(live, caller.running) ? live : null };
      }),
    ({ cause }) => ({ cause }),
  );
}

export function orderState(db: Database, order: string): OrderState {
  return loadOrder(db, order).state;
}

type StartedRun = {
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
  trace: Trace,
  db: Database,
  order: string,
  caller: Caller,
  leading: OperatorAct,
): StartedRun {
  return trace.step(
    "run_start",
    { act: leading.kind },
    () => openRun(db, order, caller, leading),
    ({ cause }) => ({ cause }),
  );
}

function openRun(db: Database, order: string, caller: Caller, leading: OperatorAct): StartedRun {
  return writeTransaction(db, () => {
    const acted = act(db, order, caller, leading);
    const orphan = clearLostRun(db, order, caller.running);
    insertRun(db, order, runKindOf(acted.state.phase), caller.self);
    return {
      by: acted.by,
      cause: acted.seq,
      created: acted.admitted.head === null,
      state: acted.state,
      orphan,
    };
  });
}

export function markHarness(db: Database, order: string, harness: ProcessId): void {
  invariant(setRunHarness(db, order, harness), `order ${order}'s run is on record while its turn starts`);
}

export function endRun(db: Database, order: string): void {
  deleteRun(db, order);
}

const actorBy = (by: WorkBy): Actor =>
  by.kind === "worker" ? actorOf(by.acting) : { kind: "factory", version, cause: by.cause };

function appendTraced(trace: Trace, db: Database, order: string, by: WorkBy, later: Later): Appended {
  return trace.step(
    "record",
    { action: later.action },
    () => append(db, order, actorBy(by), later),
    ({ seq }) => ({ entry: seq }),
  );
}

type Work = {
  readonly order: string;
  readonly station: Station;
  readonly by: WorkBy;
  readonly later: (state: OrderState) => Later;
};

export function recordAt(trace: Trace, db: Database, { order, station, by, later }: Work): Appended {
  return writeTransaction(db, () => {
    const { state } = loadOrder(db, order);
    const refusal = workRefusal(state, station, by);
    if (refusal !== null) throw refusal;
    return appendTraced(trace, db, order, by, later(state));
  });
}

export function recordAs(trace: Trace, db: Database, order: string, by: WorkBy, later: Later): Appended {
  return writeTransaction(db, () => appendTraced(trace, db, order, by, later));
}

export function showOrder(db: Database, order: string): OrderView {
  const { state, log } = loadOrder(db, order);
  return orderView(state, log, workersNamed(db, workerNamesOf(log)), workspaceDir(state.project, order));
}

export function listOrders(db: Database): readonly OrderView[] {
  return orderIds(db).map((order) => showOrder(db, order));
}
