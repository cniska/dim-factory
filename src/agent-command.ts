import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { AGENT_LABEL, installAgent } from "./ingest-launchd";

const USAGE = "usage: dim agent install";

export const agentCommand: Command = {
  name: "agent",
  usage: USAGE,
  summary: "write the launchd agent that syncs every 15 minutes",
  run(args) {
    const [verb, ...rest] = args;
    if (verb !== "install") throw new UsageError(USAGE);
    parseArgs(rest, { positionals: [0, 0], flags: [] }, "dim agent install");
    const { path, unchanged } = installAgent();
    if (unchanged) return { path, unchanged };
    return {
      path,
      unchanged,
      next: `launchctl bootstrap gui/$(id -u) ${path}`,
      remove: `launchctl bootout gui/$(id -u)/${AGENT_LABEL}`,
    };
  },
};
