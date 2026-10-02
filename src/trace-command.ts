import type { Database } from "bun:sqlite";
import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { openReadOnly } from "./db-read";
import { OrderId } from "./order-contract";
import { orderState, runAlive } from "./order-ops";
import { dbPath } from "./paths";
import { followTrace } from "./trace-ops";
import { runningProcesses } from "./worker-ops";

const USAGE = "usage: dim trace <order>";

function readFactory<T>(read: (db: Database) => T): T {
  const db = openReadOnly(dbPath());
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export const traceCommand: Command = {
  name: "trace",
  usage: USAGE,
  summary: "print an order's factory steps as JSONL until it has no live run",
  raw: () => true,
  run(args) {
    const [target] = parseArgs(args, { positionals: [1, 1], flags: [] }, "dim trace").positionals;
    const order = OrderId.safeParse(target);
    if (!order.success) throw new UsageError(USAGE);
    readFactory((db) => orderState(db, order.data));
    return followTrace(
      order.data,
      process.env,
      () => readFactory((db) => runAlive(db, order.data, runningProcesses())),
      (line) => process.stdout.write(`${line}\n`),
    );
  },
};
