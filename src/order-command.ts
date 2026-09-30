import type { Database } from "bun:sqlite";
import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { closeDb } from "./db";
import { openFactory } from "./factory-db";
import { OrderId } from "./order-contract";
import { addOrder, cancelOrder, showOrder, updateOrder } from "./order-ops";
import type { OrderView } from "./order-view";
import { runOrder, sendAct } from "./station-ops";
import { callerOf } from "./worker-ops";

const USAGE = [
  "usage: dim order add --title <title> --description <description> [--project <owner>/<repo>]",
  "dim order run <order>",
  "dim order show [<order>]",
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
  const fields = { title: flags.title, description: flags.description, project: flags.project, cwd };
  return showOrder(db, addOrder(db, callerOf(db, cwd), fields));
}

async function run(db: Database, args: readonly string[]): Promise<OrderView> {
  const { positionals } = parseArgs(args, { positionals: [1, 1], flags: [] }, usage);
  const order = orderArg(positionals);
  const cwd = process.cwd();
  await runOrder(db, order, callerOf(db, cwd), cwd);
  return showOrder(db, order);
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
  updateOrder(db, order, callerOf(db, process.cwd()), flags);
  return showOrder(db, order);
}

function cancel(db: Database, args: readonly string[]): OrderView {
  const { positionals, flags } = parseArgs(args, { positionals: [1, 1], flags: ["reason"] }, usage);
  if (flags.reason === undefined) throw usage("cancel needs --reason");
  const order = orderArg(positionals);
  cancelOrder(db, order, callerOf(db, process.cwd()), flags.reason);
  return showOrder(db, order);
}

function show(db: Database, args: readonly string[]): OrderView {
  const { positionals } = parseArgs(args, { positionals: [1, 1], flags: [] }, usage);
  return showOrder(db, orderArg(positionals));
}
type Verb = (db: Database, args: readonly string[]) => OrderView | Promise<OrderView>;

const VERBS: Readonly<Record<string, Verb>> = { add, run, show, update, cancel };

export const orderCommand: Command = {
  name: "order",
  usage: USAGE,
  summary: "add, run, show, update or cancel an order",
  async run(args) {
    const [verb, ...rest] = args;
    if (verb === "show" && rest.length === 0) return sendAct({ act: "order_show" });
    const act = verb === undefined ? undefined : VERBS[verb];
    if (act === undefined) throw new UsageError(USAGE);
    const db = openFactory();
    try {
      return await act(db, rest);
    } finally {
      closeDb(db);
    }
  },
};
