import { join } from "node:path";

/**
 * The `.git` at a checkout's top: a worktree's pointer file, or the primary checkout's own git
 * dir. It sits inside the tree a builder may write, and it decides which git dir — which config,
 * hooks and refs — the station runner's unsandboxed git uses when it commits that tree.
 */
export function checkoutGitPath(cwd: string): string | null {
  const top = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (top.exitCode !== 0) return null;
  const path = top.stdout.toString().trim();
  return path ? join(path, ".git") : null;
}
