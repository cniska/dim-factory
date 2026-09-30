import { realpathSync } from "node:fs";
import { workspaceDir } from "./paths";
import { branchOf } from "./workspace";
import { cloneWorkspace, diffSince, publishHead, tipOf } from "./workspace-effects";

export function baseOf(root: string, defaultBranch: string): string {
  return tipOf(root, defaultBranch);
}

export function createWorkspace(root: string, project: string, order: string, base: string): void {
  const dir = workspaceDir(project, order);
  cloneWorkspace(root, dir, branchOf(order), base);
  publishHead(root, dir, branchOf(order), base);
}

export function workspaceOf(project: string, order: string): string {
  return realpathSync(workspaceDir(project, order));
}

export function orderDiff(root: string, defaultBranch: string, head: string): string {
  return diffSince(root, defaultBranch, head);
}

export function publishRecordedHead(root: string, project: string, order: string, head: string): void {
  publishHead(root, workspaceOf(project, order), branchOf(order), head);
}
