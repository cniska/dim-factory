import { join } from "node:path";
import { tryClaimPathLock } from "./db-lock";
import { git } from "./git";
import { type Env, locksDir } from "./paths";
import type { Trace } from "./trace-contract";

const LOCK_POLL_MS = 100;

export function shipLock(trace: Trace, project: string, env: Env): Promise<() => void> {
  const path = join(locksDir(env), `ship-${project.replace("/", "-")}`);
  return trace.stepAsync("lock", { path }, async () => {
    for (;;) {
      const release = tryClaimPathLock(path);
      if (release !== null) return release;
      await Bun.sleep(LOCK_POLL_MS);
    }
  });
}

export type FastForward = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function fastForward(trace: Trace, repo: string, head: string): FastForward {
  return trace.step(
    "land",
    { repo, head },
    (): FastForward => {
      const merged = git(repo, ["merge", "-q", "--ff-only", head]);
      return merged.status === 0 ? { ok: true } : { ok: false, reason: merged.err };
    },
    (landed) => ({ landed: landed.ok }),
  );
}
