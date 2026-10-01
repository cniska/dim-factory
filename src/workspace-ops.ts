import { realpathSync } from "node:fs";
import { type Env, workspaceDir } from "./paths";
import type { Trace } from "./trace-contract";
import { branchOf, type Kept, type Rebased, type Workspace } from "./workspace";
import {
  abortRebase,
  addWorktree,
  deleteBranch,
  moveBranch,
  rebaseOnto,
  rebasing,
  removeWorktree,
  resetTo,
} from "./workspace-effects";

export function createWorkspace(
  trace: Trace,
  root: string,
  project: string,
  order: string,
  base: string,
): void {
  addWorktree(trace, root, workspaceDir(project, order), branchOf(order), base);
}

export function workspaceOf(project: string, order: string): Workspace {
  return { dir: realpathSync(workspaceDir(project, order)), branch: branchOf(order) };
}

export function settleWorkspace(trace: Trace, { dir }: Workspace, head: string): void {
  if (rebasing(dir)) abortRebase(trace, dir);
  resetTo(trace, dir, head);
}

export function workspaceRebasing({ dir }: Workspace): boolean {
  return rebasing(dir);
}

export function rebaseWorkspace(trace: Trace, { dir }: Workspace, onto: string, env: Env): Rebased {
  return rebaseOnto(trace, dir, onto, env);
}

export function moveRef(trace: Trace, repo: string, branch: string, to: string, from: string): void {
  moveBranch(trace, repo, branch, to, from);
}

export function removeWorkspaceTree(trace: Trace, root: string, { dir }: Workspace): string | null {
  return removeWorktree(trace, root, dir);
}

export function removeWorkspace(trace: Trace, root: string, { dir, branch }: Workspace): readonly Kept[] {
  const keptDir = removeWorktree(trace, root, dir);
  if (keptDir !== null) {
    return [
      { kind: "workspace", dir, reason: keptDir },
      { kind: "branch", branch, reason: "kept with its workspace" },
    ];
  }
  const keptBranch = deleteBranch(trace, root, branch);
  return keptBranch === null ? [] : [{ kind: "branch", branch, reason: keptBranch }];
}
