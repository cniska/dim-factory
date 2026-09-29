import type { CodedError } from "./coded-error";
import { git, nestedRepository } from "./git-tree";
import { fail, type Proof } from "./station-contract";

export function stagedTree(worktree: string): string {
  const staged = git(worktree, ["add", "-A"]);
  if (!staged.ok) throw new Error(`cannot stage ${worktree}: ${staged.err}`);
  const tree = git(worktree, ["write-tree"]);
  if (!tree.ok) throw new Error(`cannot read the staged tree of ${worktree}: ${tree.err}`);
  return tree.out;
}

export function nestedRefusal(worktree: string, proof: Proof | null): CodedError | null {
  const nested = nestedRepository(worktree);
  return nested === null ? null : fail("nested_repository", { nested, act: "stage", proof });
}

export function checkedTreeRefusal(
  worktree: string,
  tree: string,
  command: string,
  proof: Proof | null,
): CodedError | null {
  const nested = nestedRefusal(worktree, proof);
  if (nested) return nested;
  if (stagedTree(worktree) === tree) return null;
  return fail("check_changed_tree", { command, proof });
}
