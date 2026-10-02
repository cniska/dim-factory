import { type Command, UsageError } from "./cli-contract";
import { installRules } from "./rules";

const USAGE = "usage: dim rules install";

export const rulesCommand: Command = {
  name: "rules",
  usage: USAGE,
  summary:
    "flatten ~/.claude/CLAUDE.md into ~/.codex/AGENTS.md, which reads no imports, copying the old file aside",
  run(args) {
    if (args[0] !== "install" || args.length > 1) throw new UsageError(USAGE);
    const { source, path, state, backup } = installRules();
    return { source, path, state, backup };
  },
};
