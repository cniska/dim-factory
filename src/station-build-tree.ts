import { git, nestedRepository } from "./git-tree";

export function stagedTree(worktree: string): string {
  const staged = git(worktree, ["add", "-A"]);
  if (!staged.ok) throw new Error(`cannot stage ${worktree}: ${staged.err}`);
  const tree = git(worktree, ["write-tree"]);
  if (!tree.ok) throw new Error(`cannot read the staged tree of ${worktree}: ${tree.err}`);
  return tree.out;
}

export type TreeRefusal = { code: "nested_repository" | "check_changed_tree"; message: string };

export function nestedRefusal(worktree: string): TreeRefusal | null {
  const nested = nestedRepository(worktree);
  if (nested === null) return null;
  return {
    code: "nested_repository",
    message: `${nested} is a git repository inside the worktree, which the runner does not stage`,
  };
}

export function checkedTreeRefusal(worktree: string, tree: string, command: string): TreeRefusal | null {
  const nested = nestedRefusal(worktree);
  if (nested) return nested;
  if (stagedTree(worktree) === tree) return null;
  return {
    code: "check_changed_tree",
    message: `the check changed the worktree while it ran, so it did not run over the tree it was handed: ${command}`,
  };
}
