import { invariant } from "./assert";
import { checkDeclared, manifestsAt } from "./declared-tasks";
import { git } from "./git-tree";

function ran(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  invariant(result.ok, `git ${args.join(" ")} in ${cwd}: ${result.err}`);
  return result.out;
}

export function branchTip(workspace: string, branch: string): string {
  return ran(workspace, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
}

export function parentsOf(workspace: string, commit: string): readonly string[] {
  const [, ...parents] = ran(workspace, ["rev-list", "--parents", "-n", "1", commit]).split(" ");
  return parents;
}

export function isClean(workspace: string): boolean {
  return ran(workspace, ["status", "--porcelain", "--untracked-files=all"]) === "";
}

export function moveBranch(workspace: string, branch: string, to: string, from: string): void {
  ran(workspace, ["update-ref", `refs/heads/${branch}`, to, from]);
}

function declarationAt(workspace: string, commit: string): string | null {
  const manifests = manifestsAt(workspace, commit);
  invariant(manifests !== null, `${commit} names a commit in ${workspace}`);
  const task = checkDeclared(manifests);
  return task === null ? null : JSON.stringify(task);
}

export function checkChanged(workspace: string, tip: string, head: string): boolean {
  return declarationAt(workspace, tip) !== declarationAt(workspace, head);
}
