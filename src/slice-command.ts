import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { WORKER_COMMAND } from "./station-contract";
import { sendAct } from "./station-ops";

const USAGE = `usage: ${WORKER_COMMAND.slice_submit}`;

export const sliceCommand: Command = {
  name: "slice",
  usage: USAGE,
  summary: "hand in the slice just committed, from inside the builder's turn",
  run(args) {
    const [verb, ...rest] = args;
    if (verb !== "submit") throw new UsageError(USAGE);
    parseArgs(rest, { positionals: [0, 0], flags: [] }, "dim slice submit");
    return sendAct({ act: "slice_submit" }, process.env);
  },
};
