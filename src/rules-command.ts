import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { installRules } from "./rules";

const USAGE = "usage: dim rules install";

export const rulesCommand: Command = {
  name: "rules",
  usage: USAGE,
  summary:
    "flatten ~/.claude/CLAUDE.md into ~/.codex/AGENTS.md, which reads no imports, copying the old file aside",
  run(args) {
    const [verb, ...rest] = args;
    if (verb !== "install") throw new UsageError(USAGE);
    parseArgs(rest, { positionals: [0, 0], flags: [] }, "dim rules install");
    const { source, path, state, backup } = installRules();
    return { source, path, state, backup };
  },
};
