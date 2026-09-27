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
import { withPathLock } from "./db-lock";
import { defaultDataDir, type Env, resolveHomeDir } from "./paths";

export const SKILL_NAMES = [
  "dim-add",
  "dim-audit",
  "dim-artifact",
  "dim-feat",
  "dim-fix",
  "dim-plan",
  "dim-build",
  "dim-review",
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

type SkillPlanBase = {
  name: SkillName;
  link: string;
  target: string;
};

export type SkillPlan = SkillPlanBase &
  ({ state: "linked" | "missing" } | { state: "occupied"; backup: string });

function backupPath(link: string): string {
  const base = `${link}.dim-backup`;
  let path = base;
  let number = 2;
  while (lstatSync(path, { throwIfNoEntry: false })) {
    path = `${base}-${number}`;
    number += 1;
  }
  return path;
}

export function planSkill(env: Env = process.env): SkillPlan[] {
  return SKILL_NAMES.flatMap((name) => {
    const target = skillSourceDir(name);
    return skillLinkPaths(name, env).map((link) => {
      if (!existsSync(link) && !isLink(link)) return { name, link, target, state: "missing" as const };
      if (isLink(link) && readlinkSync(link) === target)
        return { name, link, target, state: "linked" as const };
      return { name, link, target, state: "occupied" as const, backup: backupPath(link) };
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
  return withPathLock(join(defaultDataDir(env), "skill-install.lock"), () => {
    const plans = planSkill(env);
    for (const plan of plans) {
      if (plan.state === "linked") continue;
      mkdirSync(dirname(plan.link), { recursive: true });
      if (plan.state === "occupied") renameSync(plan.link, plan.backup);
      symlinkSync(plan.target, plan.link);
    }
    for (const link of retiredLinks(env)) unlinkSync(link);
    return plans;
  });
}
