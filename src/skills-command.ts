import { type Command, UsageError } from "./cli-contract";
import { installSkill, planSkill, SKILL_NAMES, type SkillPlan } from "./skill";

const USAGE = "usage: dim skills install";

function skillState(plans: SkillPlan[]) {
  const linked = SKILL_NAMES.filter((name) =>
    plans.every((plan) => plan.name !== name || plan.state === "linked"),
  ).length;
  return { linked, links: plans };
}

export const skillsCommand: Command = {
  name: "skills",
  usage: USAGE,
  summary: "link this repo's skills where every agent looks for them, moving an occupied link aside",
  run(args) {
    if (args[0] !== "install" || args.length > 1) throw new UsageError(USAGE);
    const backups = installSkill().flatMap((plan) => (plan.state === "occupied" ? [plan.backup] : []));
    return { ...skillState(planSkill()), backups };
  },
};
