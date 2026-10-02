import { readFileSync } from "node:fs";
import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { WORKER_COMMAND } from "./station-contract";
import { sendAct } from "./station-ops";

const USAGE = `usage: ${WORKER_COMMAND.plan_return}`;

export const planCommand: Command = {
  name: "plan",
  usage: USAGE,
  summary: "return the plan, from inside the planner's turn",
  run(args) {
    const [verb, ...rest] = args;
    if (verb !== "return") throw new UsageError(USAGE);
    const [file] = parseArgs(rest, { positionals: [1, 1], flags: [] }, "dim plan return").positionals;
    if (file === undefined) throw new UsageError(USAGE);
    return sendAct({ act: "plan_return", plan: readFileSync(file, "utf8") }, process.env);
  },
};
