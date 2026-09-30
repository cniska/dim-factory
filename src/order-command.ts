import type { Database } from "bun:sqlite";
import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { readConfig } from "./config";
import { closeDb, writeTransaction } from "./db";
import { openFactory } from "./factory-db";
import { openSessionsUnder, sessionDirs } from "./hooks-sessions";
import { drainSpool } from "./ingest-spool";
import { admit, fold, type OperatorAct, type OrderState, orderIdOf } from "./order";
import { type Actor, type Detailed, type LogEntry, OrderId, refuse } from "./order-contract";
import { appendEntries, readLog } from "./order-store";
import { type OrderView, type OrderWorker, orderView, workerNamesOf } from "./order-view";
import { workspaceDir } from "./paths";
import { type Checkout, checkoutAt, defaultBranch } from "./project";
import { actingSession, ancestry } from "./worker";
import { refuse as refuseWorker } from "./worker-contract";
import { processTable } from "./worker-effects";
import { sessions, sessionsOf, stationWorkersOf, workerNamed } from "./worker-store";

const USAGE = [
  "usage: dim order add --title <title> --description <description> [--project <owner>/<repo>]",
  "dim order show <order>",
  "dim order update <order> [--title <title>] [--description <description>]",
  "dim order cancel <order> --reason <reason>",
].join(" | ");

const usage = (message: string) => new UsageError(`dim order ${message}`);

function orderArg(positionals: readonly string[]): string {
  const parsed = OrderId.safeParse(positionals[0]);
  if (!parsed.success)
    throw usage(`takes an order id, eight characters such as k7m2qx4d, not ${positionals[0]}`);
  return parsed.data;
}

function actingOperator(db: Database, project: string): Actor {
  drainSpool(db);
  const chain = ancestry(processTable(), process.pid);
  const session = actingSession(chain, sessions(db));
  const worker = session === null ? null : workerNamed(db, session.worker);
  if (session !== null && worker?.role === "operator" && worker.project === project) {
    return { kind: "worker", worker: worker.name, session: session.id };
  }
  if (
    openSessionsUnder(
      db,
      chain.map((ancestor) => ancestor.pid),
    ).length === 0
  ) {
    throw refuseWorker("no_session", { cwd: process.cwd() });
  }
  throw refuseWorker("not_operator", { project });
}

function logOf(db: Database, order: string): readonly LogEntry[] {
  const log = readLog(db, order);
  if (log.length === 0) throw refuse("no_order", { order });
  return log;
}

function viewOf(db: Database, order: string): OrderView {
  const log = logOf(db, order);
  const state = fold(order, log);
  const named = new Set([...workerNamesOf(log), ...stationWorkersOf(db, order).map((worker) => worker.name)]);
  const workers = [...named].flatMap((name): OrderWorker[] => {
    const worker = workerNamed(db, name);
    return worker === null ? [] : [{ worker, sessions: sessionsOf(db, name) }];
  });
  return orderView(state, log, workers, workspaceDir(state.project, order));
}

function entry(state: OrderState, by: Actor, detailed: Detailed): LogEntry {
  return { seq: state.lastSeq + 1, at: new Date().toISOString(), by, ...detailed };
}

function checkoutOf(db: Database, project: string, here: Checkout | null): Checkout {
  if (here?.project === project) return here;
  for (const dir of sessionDirs(db)) {
    const seen = checkoutAt(dir);
    if (seen?.project === project) return seen;
  }
  throw refuse("no_checkout", { project });
}

function add(db: Database, args: readonly string[]): OrderView {
  const { flags } = parseArgs(args, { positionals: 0, flags: ["title", "description", "project"] }, usage);
  if (flags.title === undefined || flags.description === undefined)
    throw usage("add needs --title and --description");
  const here = checkoutAt(process.cwd());
  const project = flags.project ?? here?.project;
  if (project === undefined) throw refuseWorker("no_project", { cwd: process.cwd() });
  const checkout = checkoutOf(db, project, here);
  const branch = defaultBranch(checkout.root);
  if (branch === null) throw refuse("no_default_branch", { checkout: checkout.root });
  readConfig({ root: checkout.root, at: branch });
  const by = actingOperator(db, project);
  const order = orderIdOf(crypto.getRandomValues(new Uint8Array(8)));
  appendEntries(db, order, [
    {
      seq: 1,
      at: new Date().toISOString(),
      by,
      action: "order_added",
      title: flags.title,
      description: flags.description,
      project,
    },
  ]);
  return viewOf(db, order);
}

function act(
  db: Database,
  order: string,
  operatorAct: OperatorAct,
  detailed: (state: OrderState) => Detailed,
) {
  return writeTransaction(db, () => {
    const state = fold(order, logOf(db, order));
    const by = actingOperator(db, state.project);
    const refusal = admit(state, operatorAct);
    if (refusal !== null) throw refusal;
    appendEntries(db, order, [entry(state, by, detailed(state))]);
    return viewOf(db, order);
  });
}

function update(db: Database, args: readonly string[]): OrderView {
  const { positionals, flags } = parseArgs(args, { positionals: 1, flags: ["title", "description"] }, usage);
  if (flags.title === undefined && flags.description === undefined) {
    throw usage("update needs --title, --description or both");
  }
  return act(db, orderArg(positionals), "update", (state) => ({
    action: "order_updated",
    title: flags.title ?? state.title,
    description: flags.description ?? state.description,
  }));
}

function cancel(db: Database, args: readonly string[]): OrderView {
  const { positionals, flags } = parseArgs(args, { positionals: 1, flags: ["reason"] }, usage);
  if (flags.reason === undefined) throw usage("cancel needs --reason");
  const reason = flags.reason;
  return act(db, orderArg(positionals), "cancel", () => ({ action: "order_cancelled", reason }));
}

function show(db: Database, args: readonly string[]): OrderView {
  const { positionals } = parseArgs(args, { positionals: 1, flags: [] }, usage);
  return viewOf(db, orderArg(positionals));
}

const VERBS: Readonly<Record<string, (db: Database, args: readonly string[]) => OrderView>> = {
  add,
  show,
  update,
  cancel,
};

export const orderCommand: Command = {
  name: "order",
  usage: USAGE,
  summary: "add, show, update or cancel an order",
  run(args) {
    const [verb, ...rest] = args;
    const run = verb === undefined ? undefined : VERBS[verb];
    if (run === undefined) throw new UsageError(USAGE);
    const db = openFactory();
    try {
      return run(db, rest);
    } finally {
      closeDb(db);
    }
  },
};
