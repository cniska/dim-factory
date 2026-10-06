import { realpathSync } from "node:fs";
import { isClean, tipOf } from "./git";
import { type Env, workspaceDir } from "./paths";
import type { Trace } from "./trace-contract";
import { branchOf, type Kept, type Rebased, type Workspace } from "./workspace";
import * as effects from "./workspace-effects";

export function createWorkspace(
  trace: Trace,
  root: string,
  project: string,
  order: string,
  base: string,
): void {
  effects.addWorktree(trace, root, workspaceDir(project, order), branchOf(order), base);
}

export function workspaceOf(project: string, order: string): Workspace {
  return { dir: realpathSync(workspaceDir(project, order)), branch: branchOf(order) };
}

export function settleWorkspace(trace: Trace, { dir }: Workspace, head: string): void {
  if (effects.rebasing(dir)) effects.abortRebase(trace, dir);
  effects.resetTo(trace, dir, head);
}

export function restoreWorkspace(trace: Trace, { dir, branch }: Workspace, head: string): void {
  if (effects.rebasing(dir)) effects.abortRebase(trace, dir);
  effects.restoreTo(trace, dir, branch, head);
}

export function rebasing({ dir }: Workspace): boolean {
  return effects.rebasing(dir);
}

export function rebaseOnto(trace: Trace, { dir }: Workspace, onto: string, env: Env): Rebased {
  return effects.rebaseOnto(trace, dir, onto, env);
}

export function moveBranch(trace: Trace, repo: string, branch: string, to: string, from: string): void {
  effects.moveBranch(trace, repo, branch, to, from);
}

export function branchFacts({ dir, branch }: Workspace): { readonly tip: string; readonly clean: boolean } {
  return { tip: tipOf(dir, branch), clean: isClean(dir, "all") };
}

export function alignBranch(trace: Trace, { dir, branch }: Workspace, head: string): void {
  const tip = tipOf(dir, branch);
  if (tip !== head) moveBranch(trace, dir, branch, head, tip);
}

export function removeWorkspace(trace: Trace, root: string, { dir, branch }: Workspace): readonly Kept[] {
  const keptDir = effects.removeWorktree(trace, root, dir);
  if (keptDir !== null) {
    return [
      { kind: "workspace", dir, reason: keptDir },
      { kind: "branch", branch, reason: "kept with its workspace" },
    ];
  }
  const keptBranch = effects.deleteBranch(trace, root, branch);
  return keptBranch === null ? [] : [{ kind: "branch", branch, reason: keptBranch }];
}
