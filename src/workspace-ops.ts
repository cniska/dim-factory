import { realpathSync } from "node:fs";
import { workspaceDir } from "./paths";
import { branchOf } from "./workspace";
import { cloneWorkspace, tipOf } from "./workspace-effects";

export function baseOf(root: string, defaultBranch: string): string {
  return tipOf(root, defaultBranch);
}

export function createWorkspace(root: string, project: string, order: string, base: string): void {
  cloneWorkspace(root, workspaceDir(project, order), branchOf(order), base);
}

export function workspaceOf(project: string, order: string): string {
  return realpathSync(workspaceDir(project, order));
}
