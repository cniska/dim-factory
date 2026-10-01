import { join } from "node:path";
import { tryClaimPathLock } from "./db-lock";
import { git } from "./git-tree";
import { type Env, locksDir } from "./paths";

const LOCK_POLL_MS = 100;

export async function shipLock(project: string, env: Env): Promise<() => void> {
  const path = join(locksDir(env), `ship-${project.replace("/", "-")}`);
  for (;;) {
    const release = tryClaimPathLock(path);
    if (release !== null) return release;
    await Bun.sleep(LOCK_POLL_MS);
  }
}

export function checkedOutBranch(repo: string): string | null {
  const head = git(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
  return head.ok ? head.out : null;
}

export type FastForward = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function fastForward(repo: string, head: string): FastForward {
  const merged = git(repo, ["merge", "-q", "--ff-only", head]);
  return merged.ok ? { ok: true } : { ok: false, reason: merged.err };
}
