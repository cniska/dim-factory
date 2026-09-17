import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The checkout a directory belongs to, found by climbing, since a session and a
 * typed command both start wherever the person was rather than at the root.
 * Nothing outside a checkout is a repo: a walk that runs past the last `.git`
 * reaches the home directory, where a stray manifest would be read as what this
 * repo declares. A worktree holds `.git` as a file, which is a checkout root
 * the same way.
 */
export function checkoutRoot(dir: string): string | null {
  for (let at = resolve(dir), prev = ""; at !== prev; prev = at, at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
  }
  return null;
}
