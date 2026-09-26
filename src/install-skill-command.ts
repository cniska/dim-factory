import type { Command } from "./cli-contract";
import { WRITE_NEXT } from "./install-write";
import { installSkill, planSkill, retiredLinks, SKILL_NAMES } from "./skill";

export const installSkillCommand: Command = {
  name: "install-skill",
  usage: "usage: dim install-skill [--write]",
  summary: "show where this repo's skills would be linked for agents (--write links them)",
  run(args) {
    const plans = planSkill();
    const pending = plans.filter((plan) => plan.state !== "linked");
    const retired = retiredLinks();
    if (pending.length === 0 && retired.length === 0) return { linked: SKILL_NAMES.length, links: plans };
    if (!args.includes("--write")) return { pending, retired, next: WRITE_NEXT };
    installSkill();
    return { pending, retired, written: true };
  },
};
