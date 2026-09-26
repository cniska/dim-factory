import type { Database } from "bun:sqlite";
import { type Command, UsageError } from "./cli-contract";
import { readFlags, requiredFlag } from "./cli-flags";
import { withDb } from "./db";
import { clearStop, pullStop } from "./factory-stop";
import { dbPath, type Env } from "./paths";
import { resolveWorker } from "./worker";
import { resolveAssignedWorker } from "./worker-assignment";

const usage = (message: string): Error => new UsageError(message);

export const factoryCommand: Command = {
  name: "factory",
  usage: 'usage: dim factory stop --reason "..." [--order <id>]\n       dim factory clear',
  summary: "stop the whole floor taking new work, or clear the live stop",
  run(args) {
    return withDb(dbPath(), (db) => runFactoryCommand(db, args));
  },
};

export function runFactoryCommand(db: Database, args: string[], env: Env = process.env) {
  const [action, ...rest] = args;
  if (action !== "stop" && action !== "clear") {
    throw usage(`${action ?? "factory"} is not a factory subcommand`);
  }
  const given = readFlags(rest, action === "stop" ? ["--reason", "--order"] : [], usage);
  const worker = env.DIM_WORKER_ASSIGNMENT_ID ? resolveAssignedWorker(db, env) : resolveWorker(db, env);
  if (action === "stop") {
    const stop = pullStop(db, {
      reason: requiredFlag(given, "--reason", usage),
      by: worker,
      orderId: given.get("--order"),
    });
    return { action: "stopped", by: stop.pulledBy, reason: stop.reason, order_id: stop.orderId };
  }
  return { action: "cleared", reason: clearStop(db, worker).reason };
}
