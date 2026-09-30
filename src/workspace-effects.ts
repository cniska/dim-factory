import { invariant } from "./assert";
import { git } from "./git-tree";

const WORKTREE_CONFIG = [
  ["core.hooksPath", ""],
  ["commit.gpgsign", "false"],
  ["gc.auto", "0"],
] as const;

function ran(root: string, args: string[]): string {
  const result = git(root, args);
  invariant(result.ok, `git ${args.join(" ")} in ${root}: ${result.err}`);
  return result.out;
}

export function tipOf(root: string, branch: string): string {
  return ran(root, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
}

export function addWorktree(root: string, dir: string, branch: string, base: string): void {
  ran(root, ["config", "extensions.worktreeConfig", "true"]);
  ran(root, ["worktree", "add", "-q", "-b", branch, dir, base]);
  for (const [name, value] of WORKTREE_CONFIG) ran(dir, ["config", "--worktree", name, value]);
}
