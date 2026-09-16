import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Env, resolveHomeDir } from "./paths";

export const SKILL_NAME = "df-sessions";

export function skillSourceDir(): string {
  return resolve(import.meta.dir, "..", "skills", SKILL_NAME);
}

export function skillLinkPath(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".agents", "skills", SKILL_NAME);
}

export type SkillPlan = { link: string; target: string; state: "linked" | "missing" | "occupied" };

/**
 * A symlink rather than a copy: the skill is version-controlled here, so an edit
 * to it is live without a reinstall, and there is no second copy to drift.
 */
export function planSkill(env: Env = process.env): SkillPlan {
  const link = skillLinkPath(env);
  const target = skillSourceDir();
  if (!existsSync(link) && !isLink(link)) return { link, target, state: "missing" };
  if (isLink(link) && readlinkSync(link) === target) return { link, target, state: "linked" };
  return { link, target, state: "occupied" };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function installSkill(env: Env = process.env): SkillPlan {
  const plan = planSkill(env);
  if (plan.state === "linked") return plan;
  mkdirSync(join(resolveHomeDir(env), ".agents", "skills"), { recursive: true });
  // Whatever is already at the name is moved aside rather than removed: it may be
  // a skill of the owner's with the same name and no copy anywhere else.
  if (plan.state === "occupied") renameSync(plan.link, `${plan.link}.dim-backup`);
  symlinkSync(plan.target, plan.link);
  return plan;
}
