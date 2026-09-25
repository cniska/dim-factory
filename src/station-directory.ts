import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot, worktreePath } from "./wt-command";

/**
 * Where a planner or reviewer reads: the order's own worktree when the operator delegates
 * from the trunk checkout, and otherwise the directory it delegates from, taken to be a
 * worktree it chose. A builder always works in the order's worktree.
 */
export function stationDirectory(dir: string, orderId: string): string {
  const root = repoRoot(dir);
  const top = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (!top.success || resolve(top.stdout.toString().trim()) !== resolve(root)) return dir;
  const worktree = worktreePath(root, orderId);
  if (!existsSync(worktree))
    throw new Error(`order ${orderId} has no worktree at ${worktree}; claim it first`);
  return worktree;
}
