import { realpathSync } from "node:fs";
import { workspaceDir } from "./paths";
import { branchOf } from "./workspace";
import {
  cloneWorkspace,
  deleteBranch,
  publishHead,
  removeDir,
  resetTo,
  spreadTree,
} from "./workspace-effects";

export function createWorkspace(root: string, project: string, order: string, base: string): void {
  const dir = workspaceDir(project, order);
  cloneWorkspace(root, dir, branchOf(order), base);
  publishHead(root, dir, branchOf(order), base);
}

export function workspaceOf(project: string, order: string): string {
  return realpathSync(workspaceDir(project, order));
}

export function publishRecordedHead(root: string, project: string, order: string, head: string): void {
  publishHead(root, workspaceOf(project, order), branchOf(order), head);
}

export function resetWorkspace(root: string, project: string, order: string, head: string): void {
  resetTo(workspaceOf(project, order), root, branchOf(order), head);
}

export function spreadMerge(project: string, order: string, tree: string): void {
  spreadTree(workspaceOf(project, order), tree);
}

export type Kept = { readonly path: string; readonly reason: string };

export function removeWorkspace(root: string, project: string, order: string): readonly Kept[] {
  const dir = workspaceOf(project, order);
  const branch = branchOf(order);
  const keptDir = removeDir(dir);
  if (keptDir !== null)
    return [
      { path: dir, reason: keptDir },
      { path: branch, reason: "kept with its workspace" },
    ];
  const keptBranch = deleteBranch(root, branch);
  return keptBranch === null ? [] : [{ path: branch, reason: keptBranch }];
}
