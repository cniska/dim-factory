import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { git, ran } from "./git";
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

function registered(root: string, dir: string): boolean {
  const parent = dirname(dir);
  const recorded = existsSync(parent) ? join(realpathSync(parent), basename(dir)) : dir;
  return ran(root, ["worktree", "list", "--porcelain"]).split("\n").includes(`worktree ${recorded}`);
}

export function addWorktree(trace: Trace, root: string, dir: string, branch: string, base: string): void {
  trace.step("worktree_add", { dir, base }, () => {
    if (registered(root, dir)) {
      const removed = git(root, ["worktree", "remove", "--force", dir]);
      if (removed.status !== 0) throw refuseWorkspace("workspace_failed", { dir, detail: removed.err });
    }
    const added = git(root, [...NO_HOOKS, "worktree", "add", "-q", "-B", branch, dir, base]);
    if (added.status !== 0) throw refuseWorkspace("workspace_failed", { dir, detail: added.err });
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

function aborted(dir: string): void {
  ran(dir, [...NO_HOOKS, "rebase", "--abort"]);
}

export function abortRebase(trace: Trace, dir: string): void {
  trace.step("rebase_abort", { dir }, () => aborted(dir));
}

export function rebaseOnto(trace: Trace, dir: string, onto: string, env: Env): Rebased {
  return trace.step(
    "rebase",
    { dir, onto },
    (): Rebased => {
      const rebased = git(dir, [...NO_HOOKS, ...REBASE, onto], { env });
      if (rebased.status === 0) return { kind: "rebased" };
      const unmerged = ran(dir, ["diff", "--name-only", "--diff-filter=U"]);
      if (rebasing(dir)) aborted(dir);
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
      return removed.status === 0 ? null : removed.err;
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
      return deleted.status === 0 ? null : deleted.err;
    },
    (kept) => ({ kept: kept !== null }),
  );
}

export function moveBranch(trace: Trace, repo: string, branch: string, to: string, from: string): void {
  trace.step("branch_move", { repo, branch, to }, () =>
    ran(repo, ["update-ref", `refs/heads/${branch}`, to, from]),
  );
}
