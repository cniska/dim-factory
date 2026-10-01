import { invariant } from "./assert";
import { checkDeclared, manifestsAt } from "./declared-tasks";
import { ran } from "./git-tree";

export function parentsOf(workspace: string, commit: string): readonly string[] {
  const [, ...parents] = ran(workspace, ["rev-list", "--parents", "-n", "1", commit]).split(" ");
  return parents;
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
