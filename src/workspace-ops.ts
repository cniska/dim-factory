import { realpathSync } from "node:fs";
import { type Env, workspaceDir } from "./paths";
import { branchOf, type Kept, type Rebased, type Workspace } from "./workspace";
import {
  abortRebase,
  addWorktree,
  deleteBranch,
  rebaseOnto,
  rebasing,
  removeWorktree,
  resetTo,
} from "./workspace-effects";

export function createWorkspace(root: string, project: string, order: string, base: string): void {
  addWorktree(root, workspaceDir(project, order), branchOf(order), base);
}

export function workspaceOf(project: string, order: string): Workspace {
  return { dir: realpathSync(workspaceDir(project, order)), branch: branchOf(order) };
}

export function settleWorkspace({ dir }: Workspace, head: string): void {
  if (rebasing(dir)) abortRebase(dir);
  resetTo(dir, head);
}

export function workspaceRebasing({ dir }: Workspace): boolean {
  return rebasing(dir);
}

export function rebaseWorkspace({ dir }: Workspace, onto: string, env: Env): Rebased {
  return rebaseOnto(dir, onto, env);
}

export function removeWorkspace(root: string, { dir, branch }: Workspace): readonly Kept[] {
  const keptDir = removeWorktree(root, dir);
  if (keptDir !== null) {
    return [
      { kind: "workspace", dir, reason: keptDir },
      { kind: "branch", branch, reason: "kept with its workspace" },
    ];
  }
  const keptBranch = deleteBranch(root, branch);
  return keptBranch === null ? [] : [{ kind: "branch", branch, reason: keptBranch }];
}
