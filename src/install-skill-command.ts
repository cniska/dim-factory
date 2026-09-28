import type { Command } from "./cli-contract";
import { WRITE_NEXT } from "./install-write";
import { installSkill, planSkill, retiredLinks, SKILL_NAMES, type SkillPlan } from "./skill";

function skillState(plans: SkillPlan[]) {
  const linked = SKILL_NAMES.filter((name) =>
    plans.every((plan) => plan.name !== name || plan.state === "linked"),
  ).length;
  return { linked, links: plans };
}

export const installSkillCommand: Command = {
  name: "install-skill",
  usage: "usage: dim install-skill [--write]",
  summary: "show where this repo's skills would be linked for agents (--write links them)",
  run(args) {
    const plans = planSkill();
    const pending = plans.filter((plan) => plan.state !== "linked");
    const retired = retiredLinks();
    if (pending.length === 0 && retired.length === 0) return skillState(plans);
    if (!args.includes("--write")) return { pending, retired, next: WRITE_NEXT };
    const backups = installSkill().flatMap((plan) => (plan.state === "occupied" ? [plan.backup] : []));
    return { ...skillState(planSkill()), written: true, backups };
  },
};
