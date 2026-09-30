import { invariant } from "./assert";
import { git } from "./git-tree";
import { refuseWorkspace } from "./workspace-contract";

const WORKTREE_CONFIG = [
  ["core.hooksPath", ""],
  ["commit.gpgsign", "false"],
  ["gc.auto", "0"],
] as const;

export function tipOf(root: string, branch: string): string {
  const tip = git(root, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  invariant(tip.ok, `the default branch ${branch} of ${root} names a commit: ${tip.err}`);
  return tip.out;
}

export function addWorktree(root: string, dir: string, branch: string, base: string): void {
  for (const [cwd, args] of [
    [root, ["config", "extensions.worktreeConfig", "true"]],
    [root, ["worktree", "add", "-q", "-b", branch, dir, base]],
    ...WORKTREE_CONFIG.map(([name, value]) => [dir, ["config", "--worktree", name, value]] as const),
  ] as const) {
    const ran = git(cwd, [...args]);
    if (!ran.ok) throw refuseWorkspace("workspace_failed", { dir, detail: ran.err });
  }
}
