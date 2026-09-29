import { existsSync } from "node:fs";
import { fail } from "./station-contract";
import { repoRoot, worktreePath } from "./worktree";

export function stationDirectory(dir: string, orderId: string): string {
  const worktree = worktreePath(repoRoot(dir), orderId);
  if (!existsSync(worktree)) throw fail("worktree_missing", { orderId, worktree });
  return worktree;
}
