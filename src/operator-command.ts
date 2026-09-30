import { type Command, UsageError } from "./cli-contract";
import { closeDb } from "./db";
import { openFactory } from "./factory-db";
import { registerOperator } from "./worker-ops";

const USAGE = "usage: dim operator register";

export const operatorCommand: Command = {
  name: "operator",
  usage: USAGE,
  summary: "register the harness session this runs in as its project's operator",
  run(args) {
    if (args[0] !== "register" || args.length > 1) throw new UsageError(USAGE);
    const db = openFactory();
    try {
      return registerOperator(db, process.cwd());
    } finally {
      closeDb(db);
    }
  },
};
