import { readFileSync } from "node:fs";
import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { WORKER_COMMAND } from "./station-contract";
import { sendAct } from "./station-ops";

const USAGE = `usage: ${WORKER_COMMAND.build_return}`;

export const buildCommand: Command = {
  name: "build",
  usage: USAGE,
  summary: "return the Build artifact, from inside the builder's turn",
  run(args) {
    const [verb, ...rest] = args;
    if (verb !== "return") throw new UsageError(USAGE);
    const [file] = parseArgs(rest, { positionals: [1, 1], flags: [] }, "dim build return").positionals;
    if (file === undefined) throw new UsageError(USAGE);
    return sendAct({ act: "build_return", artifact: readFileSync(file, "utf8") }, process.env);
  },
};
