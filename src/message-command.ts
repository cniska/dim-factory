import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { closeDb, openDb } from "./db";
import { OrderId, Station } from "./order-contract";
import { dbPath } from "./paths";
import { inTurn, messageWorker, sendAct } from "./station-ops";
import { callerOf } from "./worker-ops";

const USAGE = "usage: dim message send <text> --order <order> --to plan|build|review";

const TURN_USAGE =
  "usage, inside a station turn: dim message send <text> [--to <recipient>], which reaches only the operator";

const usage = (message: string) => new UsageError(`dim message ${message}`);

async function send(args: readonly string[]) {
  const { positionals, flags } = parseArgs(args, { positionals: [1, 1], flags: ["order", "to"] }, usage);
  const [text] = positionals;
  if (text === undefined) throw new UsageError(USAGE);
  if (inTurn(process.env)) {
    if (flags.order !== undefined) throw new UsageError(TURN_USAGE);
    return sendAct({ act: "message_send", text, to: flags.to ?? null }, process.env);
  }
  const order = OrderId.safeParse(flags.order);
  const station = Station.safeParse(flags.to);
  if (!order.success || !station.success) throw new UsageError(USAGE);
  const db = openDb(dbPath());
  try {
    const caller = callerOf(db, process.cwd());
    const reply = await messageWorker(db, order.data, caller, { station: station.data, text }, process.env);
    return { reply };
  } finally {
    closeDb(db);
  }
}

export const messageCommand: Command = {
  name: "message",
  usage: USAGE,
  summary: "send a station worker a message and print its reply, or from inside a turn, message the operator",
  run(args) {
    const [verb, ...rest] = args;
    if (verb !== "send") throw new UsageError(USAGE);
    return send(rest);
  },
};
