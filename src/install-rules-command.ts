import type { Command } from "./cli-contract";
import { WRITE_NEXT } from "./install-write";
import { installRules, planRules } from "./rules";

export const installRulesCommand: Command = {
  name: "install-rules",
  usage: "usage: dim install-rules [--write]",
  summary: "flatten ~/.claude/CLAUDE.md into ~/.codex/AGENTS.md, which reads no imports (--write applies it)",
  run(args) {
    const plan = planRules();
    if (plan.state === "missing-source" || plan.state === "unchanged") return plan;
    const summary = { ...plan, lines: plan.contents.split("\n").length };
    if (!args.includes("--write")) return { ...summary, next: WRITE_NEXT };
    installRules();
    return { ...summary, written: true, backup: plan.state === "stale" ? `${plan.path}.dim-backup` : null };
  },
};
