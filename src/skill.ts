import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Env, resolveHomeDir } from "./paths";

/**
 * The skills that ship from here. Each needs `dim` on PATH because it reads the
 * local record, and adding one is a directory beside this file plus a name here.
 */
export const SKILL_NAMES = [
  "dim-line-feat",
  "dim-line-fix",
  "dim-station-plan",
  "dim-station-build",
  "dim-handoff",
  "dim-station-review",
  "dim-factory",
  "dim-git",
  "dim-tdd",
  "dim-simplify",
  "dim-rules",
] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

export function skillSourceDir(name: SkillName): string {
  return resolve(import.meta.dir, "..", "skills", name);
}

/**
 * Every tool whose sessions the database holds, because the value of asking it
 * is largest for the agent that was not there. Claude and Acolyte both read
 * `~/.agents/skills` — Claude through its own symlink, Acolyte by the same
 * convention — so that one link serves both. Codex reads its own directory.
 */
export function skillLinkDirs(env: Env = process.env): string[] {
  const home = resolveHomeDir(env);
  return [join(home, ".agents", "skills"), join(home, ".codex", "skills")];
}

export function skillLinkPaths(name: SkillName, env: Env = process.env): string[] {
  return skillLinkDirs(env).map((dir) => join(dir, name));
}

export type SkillPlan = {
  name: SkillName;
  link: string;
  target: string;
  state: "linked" | "missing" | "occupied";
};

/**
 * A symlink rather than a copy: the skill is version-controlled here, so an edit
 * to it is live without a reinstall, and there is no second copy to drift.
 */
export function planSkill(env: Env = process.env): SkillPlan[] {
  return SKILL_NAMES.flatMap((name) => {
    const target = skillSourceDir(name);
    return skillLinkPaths(name, env).map((link) => {
      if (!existsSync(link) && !isLink(link)) return { name, link, target, state: "missing" as const };
      if (isLink(link) && readlinkSync(link) === target)
        return { name, link, target, state: "linked" as const };
      return { name, link, target, state: "occupied" as const };
    });
  });
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Links pointing into this repo's skills directory for a station that no longer
 * ships. Retiring a station would otherwise leave a link resolving to nothing,
 * which reads to the tool as a skill that will not load rather than one that is
 * gone. Only links into this repo are considered: anything else is the owner's.
 */
export function retiredLinks(env: Env = process.env): string[] {
  const root = resolve(import.meta.dir, "..", "skills");
  const current = new Set<string>(SKILL_NAMES.map((name) => skillSourceDir(name)));
  const stale: string[] = [];
  for (const dir of skillLinkDirs(env)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const link = join(dir, entry);
      if (!isLink(link)) continue;
      const target = readlinkSync(link);
      if (target.startsWith(`${root}/`) && !current.has(target)) stale.push(link);
    }
  }
  return stale;
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
  // Removed rather than moved aside: this link was written by an earlier install
  // from here, so there is nothing of the owner's under it to keep.
  for (const link of retiredLinks(env)) unlinkSync(link);
  return plans;
}
