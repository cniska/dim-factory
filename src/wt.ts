import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Env } from "./paths";

/**
 * `wt` ships here rather than on its own because this is the repo that already
 * depends on the convention it establishes — see [worktree.ts](worktree.ts).
 * A symlink rather than a copy: a copy on PATH and a copy in the repo drift,
 * and drifting is the state it was adopted out of.
 */
export const WT_BIN = "/usr/local/bin/wt";

export type WtPlan = {
  source: string;
  link: string;
  state: "linked" | "missing" | "occupied";
  /** What is there now, when something other than this repo's script is. */
  occupant: string | null;
};

export function wtSource(): string {
  return resolve(import.meta.dir, "..", "scripts", "wt");
}

export function planWt(env: Env = process.env): WtPlan {
  const source = wtSource();
  const link = env.DIM_WT_BIN ?? WT_BIN;
  if (!existsSync(link)) return { source, link, state: "missing", occupant: null };

  const stat = lstatSync(link);
  if (!stat.isSymbolicLink()) return { source, link, state: "occupied", occupant: link };
  const target = readlinkSync(link);
  return target === source
    ? { source, link, state: "linked", occupant: null }
    : { source, link, state: "occupied", occupant: target };
}

/**
 * Whatever is already at the path is moved aside rather than deleted: it is a
 * working tool until this replaces it, and the copy it replaces is the only one
 * that existed.
 */
export function installWt(env: Env = process.env): WtPlan {
  const plan = planWt(env);
  if (plan.state === "linked") return plan;

  mkdirSync(dirname(plan.link), { recursive: true });
  if (existsSync(plan.link) || lstatSafe(plan.link)) {
    // Renamed, never deleted: what is there is a working tool, and for a real
    // file this is the only copy of it in existence.
    const aside = `${plan.link}.dim-backup`;
    rmSync(aside, { force: true });
    renameSync(plan.link, aside);
  }
  symlinkSync(plan.source, plan.link);
  return { ...plan, state: "linked", occupant: null };
}

/** `existsSync` follows the link, so a symlink to nothing needs asking separately. */
function lstatSafe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export const wtTestPath = (): string => join(dirname(wtSource()), "wt.test.sh");
