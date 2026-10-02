import type { Database } from "bun:sqlite";
import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { closeDb, openDb } from "./db";
import { Decision, OrderId, Reason } from "./order-contract";
import { addOrder, showOrder, updateOrder } from "./order-ops";
import { dbPath } from "./paths";
import { WORKER_COMMAND } from "./station-contract";
import { advanceOrder, cancelOrder, inTurn, sendAct } from "./station-ops";
import { callerOf } from "./worker-ops";

const USAGE = [
  "usage: dim order add --title <title> --description <description> [--project <owner>/<repo>]",
  "dim order run <order>",
  "dim order approve <order> --reason <reason> --decided owner|operator",
  "dim order show <order>",
  "dim order return <order> --reason <reason> --decided owner|operator",
  "dim order update <order> [--title <title>] [--description <description>]",
  "dim order cancel <order> --reason <reason>",
].join(" | ");

const TURN_USAGE = `usage, inside a station turn: ${WORKER_COMMAND.order_show} | ${WORKER_COMMAND.order_return}`;

const usage = (message: string) => new UsageError(`dim order ${message}`);

function orderArg(positionals: readonly string[]): string {
  const parsed = OrderId.safeParse(positionals[0]);
  if (!parsed.success)
    throw usage(`takes an order id, eight characters such as k7m2qx4d, not ${positionals[0]}`);
  return parsed.data;
}

function add(db: Database, args: readonly string[]) {
  const { flags } = parseArgs(
    args,
    { positionals: [0, 0], flags: ["title", "description", "project"] },
    "dim order",
  );
  if (flags.title === undefined || flags.description === undefined) {
    throw usage("add needs --title and --description");
  }
  const fields = { title: flags.title, description: flags.description, project: flags.project };
  return showOrder(db, addOrder(db, callerOf(db, process.cwd()), fields));
}

async function run(db: Database, args: readonly string[]) {
  const { positionals } = parseArgs(args, { positionals: [1, 1], flags: [] }, "dim order");
  const order = orderArg(positionals);
  await advanceOrder(db, order, callerOf(db, process.cwd()), { kind: "run" }, process.env);
  return showOrder(db, order);
}

function decisionOf(verb: string, flags: { readonly reason?: string; readonly decided?: string }): Decision {
  const decision = Decision.safeParse({ reason: flags.reason, decidedBy: flags.decided });
  if (!decision.success) throw usage(`${verb} needs a non-blank --reason and --decided owner|operator`);
  return decision.data;
}

async function approve(db: Database, args: readonly string[]) {
  const { positionals, flags } = parseArgs(
    args,
    { positionals: [1, 1], flags: ["reason", "decided"] },
    "dim order",
  );
  const order = orderArg(positionals);
  const decision = decisionOf("approve", flags);
  await advanceOrder(db, order, callerOf(db, process.cwd()), { kind: "approve", decision }, process.env);
  return showOrder(db, order);
}

async function returnArtifact(db: Database, args: readonly string[]) {
  const { positionals, flags } = parseArgs(
    args,
    { positionals: [1, 1], flags: ["reason", "decided"] },
    "dim order",
  );
  const order = orderArg(positionals);
  const decision = decisionOf("return", flags);
  await advanceOrder(db, order, callerOf(db, process.cwd()), { kind: "return", decision }, process.env);
  return showOrder(db, order);
}

function update(db: Database, args: readonly string[]) {
  const { positionals, flags } = parseArgs(
    args,
    { positionals: [1, 1], flags: ["title", "description"] },
    "dim order",
  );
  if (flags.title === undefined && flags.description === undefined) {
    throw usage("update needs --title, --description or both");
  }
  const order = orderArg(positionals);
  updateOrder(db, order, callerOf(db, process.cwd()), flags);
  return showOrder(db, order);
}

function cancel(db: Database, args: readonly string[]) {
  const { positionals, flags } = parseArgs(args, { positionals: [1, 1], flags: ["reason"] }, "dim order");
  const reason = Reason.safeParse(flags.reason);
  if (!reason.success) throw usage("cancel needs a non-blank --reason");
  const order = orderArg(positionals);
  cancelOrder(db, order, callerOf(db, process.cwd()), reason.data, process.env);
  return showOrder(db, order);
}

function show(db: Database, args: readonly string[]) {
  const { positionals } = parseArgs(args, { positionals: [1, 1], flags: [] }, "dim order");
  return showOrder(db, orderArg(positionals));
}

type Verb = (db: Database, args: readonly string[]) => unknown;

const VERBS = new Map<string, Verb>([
  ["add", add],
  ["run", run],
  ["approve", approve],
  ["return", returnArtifact],
  ["show", show],
  ["update", update],
  ["cancel", cancel],
]);

type TurnVerb = (args: readonly string[]) => Promise<unknown>;

const TURN_VERBS = new Map<string, TurnVerb>([
  [
    "show",
    (args) => {
      parseArgs(args, { positionals: [0, 0], flags: [] }, "dim order");
      return sendAct({ act: "order_show" }, process.env);
    },
  ],
  [
    "return",
    (args) => {
      const { flags } = parseArgs(args, { positionals: [0, 0], flags: ["reason"] }, "dim order");
      if (flags.reason === undefined) throw usage("return needs --reason");
      return sendAct({ act: "order_return", reason: flags.reason }, process.env);
    },
  ],
]);

export const orderCommand: Command = {
  name: "order",
  usage: USAGE,
  summary: "add, run, show, update or cancel an order, or from inside a turn, show or return its order",
  async run(args) {
    const [verb, ...rest] = args;
    if (inTurn(process.env)) {
      const turnVerb = verb === undefined ? undefined : TURN_VERBS.get(verb);
      if (turnVerb === undefined) throw new UsageError(TURN_USAGE);
      return turnVerb(rest);
    }
    const act = verb === undefined ? undefined : VERBS.get(verb);
    if (act === undefined) throw new UsageError(USAGE);
    const db = openDb(dbPath());
    try {
      return await act(db, rest);
    } finally {
      closeDb(db);
    }
  },
};
