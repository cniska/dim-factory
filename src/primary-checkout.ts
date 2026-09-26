import { dirname } from "node:path";

/**
 * The main working tree even from a task worktree: `--git-common-dir` resolves to the
 * shared `.git`, whose parent is the checkout the trunk branch is worked from. Null
 * where `dir` is not a git repo that can be read.
 */
export function primaryCheckout(dir: string): string | null {
  const run = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return run.success ? dirname(run.stdout.toString().trim()) : null;
}
