import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Env, resolveHomeDir } from "./paths";

export const SKILL_NAME = "df-sessions";

export function skillSourceDir(): string {
  return resolve(import.meta.dir, "..", "skills", SKILL_NAME);
}

/**
 * Every tool whose sessions the database holds, because the value of asking it
 * is largest for the agent that was not there. Claude and Acolyte both read
 * `~/.agents/skills` — Claude through its own symlink, Acolyte by the same
 * convention — so that one link serves both. Codex reads its own directory.
 */
export function skillLinkPaths(env: Env = process.env): string[] {
  const home = resolveHomeDir(env);
  return [join(home, ".agents", "skills", SKILL_NAME), join(home, ".codex", "skills", SKILL_NAME)];
}

export type SkillPlan = { link: string; target: string; state: "linked" | "missing" | "occupied" };

/**
 * A symlink rather than a copy: the skill is version-controlled here, so an edit
 * to it is live without a reinstall, and there is no second copy to drift.
 */
export function planSkill(env: Env = process.env): SkillPlan[] {
  const target = skillSourceDir();
  return skillLinkPaths(env).map((link) => {
    if (!existsSync(link) && !isLink(link)) return { link, target, state: "missing" as const };
    if (isLink(link) && readlinkSync(link) === target) return { link, target, state: "linked" as const };
    return { link, target, state: "occupied" as const };
  });
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function installSkill(env: Env = process.env): SkillPlan[] {
  const plans = planSkill(env);
  for (const plan of plans) {
    if (plan.state === "linked") continue;
    mkdirSync(dirname(plan.link), { recursive: true });
    // Whatever is already at the name is moved aside rather than removed: it may
    // be a skill of the owner's with the same name and no copy anywhere else.
    if (plan.state === "occupied") renameSync(plan.link, `${plan.link}.dim-backup`);
    symlinkSync(plan.target, plan.link);
  }
  return plans;
}
