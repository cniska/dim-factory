import { readFileSync } from "node:fs";
import { type Command, UsageError } from "./cli-contract";
import { WORKER_COMMAND } from "./station-contract";
import { sendAct } from "./station-ops";

const USAGE = `usage: ${WORKER_COMMAND.build_return}`;

export const buildCommand: Command = {
  name: "build",
  usage: USAGE,
  summary: "return the Build artifact, from inside the builder's turn",
  run(args) {
    const [verb, file, ...rest] = args;
    if (verb !== "return" || file === undefined || rest.length > 0) throw new UsageError(USAGE);
    return sendAct({ act: "build_return", artifact: readFileSync(file, "utf8") }, process.env);
  },
};
