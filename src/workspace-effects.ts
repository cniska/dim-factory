import { git, ran } from "./git-tree";
import { refuseWorkspace } from "./workspace-contract";

export function addWorktree(root: string, dir: string, branch: string, base: string): void {
  const added = git(root, ["worktree", "add", "-q", "-b", branch, dir, base]);
  if (!added.ok) throw refuseWorkspace("workspace_failed", { dir, detail: added.err });
}

export function resetTo(dir: string, head: string): void {
  ran(dir, ["reset", "-q", "--hard", head]);
}

export function spreadTree(dir: string, tree: string): void {
  ran(dir, ["read-tree", "--reset", "-u", tree]);
  ran(dir, ["reset", "-q"]);
}

export function removeWorktree(root: string, dir: string): string | null {
  const removed = git(root, ["worktree", "remove", "--force", dir]);
  return removed.ok ? null : removed.err;
}

export function deleteBranch(root: string, branch: string): string | null {
  const deleted = git(root, ["update-ref", "-d", `refs/heads/${branch}`]);
  return deleted.ok ? null : deleted.err;
}
