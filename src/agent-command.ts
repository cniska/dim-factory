import { type Command, UsageError } from "./cli-contract";
import { AGENT_LABEL, installAgent } from "./ingest-launchd";

const USAGE = "usage: dim agent install";

export const agentCommand: Command = {
  name: "agent",
  usage: USAGE,
  summary: "write the launchd agent that syncs every 15 minutes",
  run(args) {
    if (args[0] !== "install" || args.length > 1) throw new UsageError(USAGE);
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
