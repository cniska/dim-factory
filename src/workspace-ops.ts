import { realpathSync } from "node:fs";
import { workspaceDir } from "./paths";
import { branchOf, type Kept, type Workspace } from "./workspace";
import { addWorktree, deleteBranch, removeWorktree, resetTo, spreadTree } from "./workspace-effects";

export function createWorkspace(root: string, project: string, order: string, base: string): void {
  addWorktree(root, workspaceDir(project, order), branchOf(order), base);
}

export function workspaceOf(project: string, order: string): Workspace {
  return { dir: realpathSync(workspaceDir(project, order)), branch: branchOf(order) };
}

export function resetWorkspace(workspace: Workspace, head: string): void {
  resetTo(workspace.dir, head);
}

export function spreadMerge(workspace: Workspace, tree: string): void {
  spreadTree(workspace.dir, tree);
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
