import { existsSync } from "node:fs";
import { git, ran } from "./git-tree";
import type { Env } from "./paths";
import type { Trace } from "./trace-contract";
import type { Rebased } from "./workspace";
import { refuseWorkspace } from "./workspace-contract";

const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

const REBASE = [
  "rebase",
  "--force-rebase",
  "--reapply-cherry-picks",
  "--empty=keep",
  "--no-autosquash",
  "--no-update-refs",
];

export function addWorktree(trace: Trace, root: string, dir: string, branch: string, base: string): void {
  trace.step("worktree_add", { dir, base }, () => {
    const added = git(root, [...NO_HOOKS, "worktree", "add", "-q", "-b", branch, dir, base]);
    if (!added.ok) throw refuseWorkspace("workspace_failed", { dir, detail: added.err });
  });
}

export function resetTo(trace: Trace, dir: string, head: string): void {
  trace.step("workspace_reset", { dir, head }, () => ran(dir, ["reset", "-q", "--hard", head]));
}

export function rebasing(dir: string): boolean {
  return ["rebase-merge", "rebase-apply"].some((state) =>
    existsSync(ran(dir, ["rev-parse", "--path-format=absolute", "--git-path", state])),
  );
}

export function abortRebase(trace: Trace, dir: string): void {
  trace.step("rebase_abort", { dir }, () => ran(dir, [...NO_HOOKS, "rebase", "--abort"]));
}

export function rebaseOnto(trace: Trace, dir: string, onto: string, env: Env): Rebased {
  return trace.step(
    "rebase",
    { dir, onto },
    (): Rebased => {
      const rebased = git(dir, [...NO_HOOKS, ...REBASE, onto], { env });
      if (rebased.ok) return { kind: "rebased" };
      const unmerged = ran(dir, ["diff", "--name-only", "--diff-filter=U"]);
      if (rebasing(dir)) ran(dir, [...NO_HOOKS, "rebase", "--abort"]);
      return unmerged === ""
        ? { kind: "failed", reason: rebased.err }
        : { kind: "conflict", paths: unmerged.split("\n") };
    },
    (done) => ({ result: done.kind }),
  );
}

export function removeWorktree(trace: Trace, root: string, dir: string): string | null {
  return trace.step(
    "worktree_remove",
    { dir },
    () => {
      const removed = git(root, ["worktree", "remove", "--force", dir]);
      return removed.ok ? null : removed.err;
    },
    (kept) => ({ kept: kept !== null }),
  );
}

export function deleteBranch(trace: Trace, root: string, branch: string): string | null {
  return trace.step(
    "branch_delete",
    { branch },
    () => {
      const deleted = git(root, ["update-ref", "-d", `refs/heads/${branch}`]);
      return deleted.ok ? null : deleted.err;
    },
    (kept) => ({ kept: kept !== null }),
  );
}

export function moveBranch(trace: Trace, repo: string, branch: string, to: string, from: string): void {
  trace.step("branch_move", { repo, branch, to }, () =>
    ran(repo, ["update-ref", `refs/heads/${branch}`, to, from]),
  );
}
