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
import { nextBackupPath } from "./file-backup";
import { HARNESSES } from "./harness-contract";
import { harnessInstalled } from "./harness-ops";
import { type Env, locksDir, resolveHomeDir } from "./paths";

const SKILLS_DIR = join(resolve(import.meta.dir, ".."), "skills");

export const SKILL_NAMES = [
  "dim-add",
  "dim-audit",
  "dim-plan",
  "dim-build",
  "dim-review",
  "dim-factory",
  "dim-rules",
] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

export function skillSourceDir(name: SkillName): string {
  return join(SKILLS_DIR, name);
}

export function skillLinkDirs(env: Env = process.env): string[] {
  const home = resolveHomeDir(env);
  const shared = join(home, ".agents", "skills");
  return harnessInstalled(HARNESSES.codex, env) ? [shared, join(home, ".codex", "skills")] : [shared];
}

export type SkillPlan = { name: SkillName; link: string; target: string } & (
  | { state: "linked" | "missing" }
  | { state: "occupied"; backup: string }
);

export function planSkill(env: Env = process.env): SkillPlan[] {
  return SKILL_NAMES.flatMap((name) => {
    const target = skillSourceDir(name);
    return skillLinkDirs(env).map((dir) => {
      const link = join(dir, name);
      const found = lstatSync(link, { throwIfNoEntry: false });
      if (!found) return { name, link, target, state: "missing" as const };
      if (found.isSymbolicLink() && readlinkSync(link) === target)
        return { name, link, target, state: "linked" as const };
      return { name, link, target, state: "occupied" as const, backup: nextBackupPath(link) };
    });
  });
}

export function retiredLinks(env: Env = process.env): string[] {
  const current = new Set<string>(SKILL_NAMES.map((name) => skillSourceDir(name)));
  const stale: string[] = [];
  for (const dir of skillLinkDirs(env)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const link = join(dir, entry);
      if (!lstatSync(link).isSymbolicLink()) continue;
      const target = readlinkSync(link);
      if (target.startsWith(`${SKILLS_DIR}/`) && !current.has(target)) stale.push(link);
    }
  }
  return stale;
}

export function installSkill(env: Env = process.env): SkillPlan[] {
  return withPathLock(join(locksDir(env), "skill-install"), () => {
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
