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

export const SKILL_NAMES = [
  "dim-add",
  "dim-artifact",
  "dim-design",
  "dim-line-feat",
  "dim-line-fix",
  "dim-station-plan",
  "dim-station-build",
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
    if (plan.state === "occupied") renameSync(plan.link, `${plan.link}.dim-backup`);
    symlinkSync(plan.target, plan.link);
  }
  for (const link of retiredLinks(env)) unlinkSync(link);
  return plans;
}
