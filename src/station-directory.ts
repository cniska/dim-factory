import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot, worktreePath } from "./worktree";

export function stationDirectory(dir: string, orderId: string): string {
  const root = repoRoot(dir);
  const top = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (!top.success || resolve(top.stdout.toString().trim()) !== resolve(root)) return dir;
  const worktree = worktreePath(root, orderId);
  if (!existsSync(worktree)) {
    throw new Error(
      `order ${orderId} has no worktree at ${worktree}; the first \`dim order plan ${orderId}\` starts it and makes one`,
    );
  }
  return worktree;
}
