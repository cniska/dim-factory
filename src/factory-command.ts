import { type Command, UsageError } from "./cli-contract";
import { readFlags, requiredFlag } from "./cli-flags";
import { withDb } from "./db";
import { clearStop, pullStop } from "./factory-stop";
import { dbPath } from "./paths";

const usage = (message: string): Error => new UsageError(message);

export const factoryCommand: Command = {
  name: "factory",
  usage:
    'usage: dim factory stop --reason "..." [--order <id>] [--by <who>]\n       dim factory clear [--by <who>]',
  summary: "stop the whole floor taking new work, or clear the live stop",
  run(args) {
    const [action, ...rest] = args;
    if (action !== "stop" && action !== "clear") {
      throw usage(`${action ?? "factory"} is not a factory subcommand`);
    }
    const given = readFlags(rest, action === "stop" ? ["--reason", "--order", "--by"] : ["--by"], usage);
    return withDb(dbPath(), (db) => {
      if (action === "stop") {
        const stop = pullStop(db, {
          reason: requiredFlag(given, "--reason", usage),
          by: given.get("--by"),
          orderId: given.get("--order"),
        });
        return { action: "stopped", by: stop.pulledBy, reason: stop.reason, order_id: stop.orderId };
      }
      return { action: "cleared", reason: clearStop(db, given.get("--by")).reason };
    });
  },
};
