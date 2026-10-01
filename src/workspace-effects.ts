import { existsSync } from "node:fs";
import { git, ran } from "./git-tree";
import type { Env } from "./paths";
import type { Rebased } from "./workspace";
import { refuseWorkspace } from "./workspace-contract";

export function addWorktree(root: string, dir: string, branch: string, base: string): void {
  const added = git(root, ["worktree", "add", "-q", "-b", branch, dir, base]);
  if (!added.ok) throw refuseWorkspace("workspace_failed", { dir, detail: added.err });
}

export function resetTo(dir: string, head: string): void {
  ran(dir, ["reset", "-q", "--hard", head]);
}

export function rebasing(dir: string): boolean {
  return ["rebase-merge", "rebase-apply"].some((state) =>
    existsSync(ran(dir, ["rev-parse", "--path-format=absolute", "--git-path", state])),
  );
}

export function abortRebase(dir: string): void {
  ran(dir, ["rebase", "--abort"]);
}

export function rebaseOnto(dir: string, onto: string, env: Env): Rebased {
  const rebased = git(
    dir,
    ["rebase", "--force-rebase", "--empty=keep", "--no-autosquash", "--no-update-refs", onto],
    { env },
  );
  if (rebased.ok) return { kind: "rebased" };
  const unmerged = ran(dir, ["diff", "--name-only", "--diff-filter=U"]);
  abortRebase(dir);
  return unmerged === ""
    ? { kind: "failed", reason: rebased.err }
    : { kind: "conflict", paths: unmerged.split("\n") };
}

export function removeWorktree(root: string, dir: string): string | null {
  const removed = git(root, ["worktree", "remove", "--force", dir]);
  return removed.ok ? null : removed.err;
}

export function deleteBranch(root: string, branch: string): string | null {
  const deleted = git(root, ["update-ref", "-d", `refs/heads/${branch}`]);
  return deleted.ok ? null : deleted.err;
}
