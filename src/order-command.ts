import type { Database } from "bun:sqlite";
import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { readConfig } from "./config";
import { closeDb } from "./db";
import { openFactory } from "./factory-db";
import { OrderId, refuseOrder } from "./order-contract";
import { addOrder, takeAct, viewOf } from "./order-ops";
import type { OrderView } from "./order-view";
import { checkoutAt, defaultBranch, lastCheckoutOf } from "./project";
import { refuseWorker } from "./worker-contract";
import { actingWorker } from "./worker-ops";

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

function add(db: Database, args: readonly string[]): OrderView {
  const { flags } = parseArgs(
    args,
    { positionals: [0, 0], flags: ["title", "description", "project"] },
    usage,
  );
  if (flags.title === undefined || flags.description === undefined) {
    throw usage("add needs --title and --description");
  }
  const cwd = process.cwd();
  const here = checkoutAt(cwd);
  const project = flags.project ?? here?.project;
  if (project === undefined) throw refuseWorker("no_project", { cwd });
  const checkout = here?.project === project ? here : lastCheckoutOf(db, project);
  if (checkout === null) throw refuseOrder("no_checkout", { project });
  const branch = defaultBranch(checkout.root);
  if (branch === null) throw refuseOrder("no_default_branch", { checkout: checkout.root });
  readConfig({ root: checkout.root, at: branch });
  const order = addOrder(db, actingWorker(db, cwd), {
    title: flags.title,
    description: flags.description,
    project,
  });
  return viewOf(db, order);
}

function update(db: Database, args: readonly string[]): OrderView {
  const { positionals, flags } = parseArgs(
    args,
    { positionals: [1, 1], flags: ["title", "description"] },
    usage,
  );
  if (flags.title === undefined && flags.description === undefined) {
    throw usage("update needs --title, --description or both");
  }
  const order = orderArg(positionals);
  takeAct(db, order, actingWorker(db, process.cwd()), { kind: "update" }, (state) => ({
    action: "order_updated",
    details: { title: flags.title ?? state.title, description: flags.description ?? state.description },
  }));
  return viewOf(db, order);
}

function cancel(db: Database, args: readonly string[]): OrderView {
  const { positionals, flags } = parseArgs(args, { positionals: [1, 1], flags: ["reason"] }, usage);
  const reason = flags.reason;
  if (reason === undefined) throw usage("cancel needs --reason");
  const order = orderArg(positionals);
  takeAct(db, order, actingWorker(db, process.cwd()), { kind: "cancel" }, () => ({
    action: "order_cancelled",
    details: { reason },
  }));
  return viewOf(db, order);
}

function show(db: Database, args: readonly string[]): OrderView {
  const { positionals } = parseArgs(args, { positionals: [1, 1], flags: [] }, usage);
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
