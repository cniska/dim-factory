import type { Command } from "./cli-contract";
import { AGENT_LABEL, installAgent, planAgent } from "./ingest-launchd";
import { WRITE_NEXT } from "./install-write";

export const installAgentCommand: Command = {
  name: "install-agent",
  usage: "usage: dim install-agent [--write]",
  summary: "show the launchd agent that syncs every 15 minutes (--write writes the plist)",
  run(args) {
    const plan = planAgent();
    if (plan.unchanged) return { path: plan.path, unchanged: true };
    if (!args.includes("--write")) return { path: plan.path, contents: plan.contents, next: WRITE_NEXT };
    installAgent();
    return {
      path: plan.path,
      written: true,
      next: `launchctl bootstrap gui/$(id -u) ${plan.path}`,
      remove: `launchctl bootout gui/$(id -u)/${AGENT_LABEL}`,
    };
  },
};
