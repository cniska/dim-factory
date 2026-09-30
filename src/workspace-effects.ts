import { invariant } from "./assert";
import { git } from "./git-tree";
import { refuseWorkspace } from "./workspace-contract";

const WORKSPACE_CONFIG = [
  ["core.hooksPath", ""],
  ["commit.gpgsign", "false"],
  ["gc.auto", "0"],
] as const;

export function tipOf(root: string, branch: string): string {
  const tip = git(root, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  invariant(tip.ok, `the default branch ${branch} of ${root} names a commit: ${tip.err}`);
  return tip.out;
}

export function cloneWorkspace(root: string, dir: string, branch: string, base: string): void {
  const origin = git(root, ["remote", "get-url", "origin"]);
  invariant(origin.ok, `the checkout ${root} names its project through an origin remote: ${origin.err}`);
  const steps: readonly (readonly [string, readonly string[]])[] = [
    [root, ["clone", "-q", "--shared", "--no-checkout", "--origin", "checkout", root, dir]],
    [dir, ["remote", "remove", "checkout"]],
    [dir, ["remote", "add", "origin", origin.out]],
    ...WORKSPACE_CONFIG.map(([name, value]) => [dir, ["config", name, value]] as const),
    [dir, ["checkout", "-q", "-b", branch, base]],
  ];
  for (const [cwd, args] of steps) {
    const ran = git(cwd, [...args]);
    if (!ran.ok) throw refuseWorkspace("workspace_failed", { dir, detail: ran.err });
  }
}

export function diffSince(root: string, defaultBranch: string, head: string): string {
  const diff = git(root, ["diff", "--no-ext-diff", "--no-color", `refs/heads/${defaultBranch}...${head}`]);
  invariant(diff.ok, `git diff of ${head} against ${defaultBranch} in ${root}: ${diff.err}`);
  return diff.out;
}

export function publishHead(root: string, dir: string, branch: string, head: string): void {
  for (const args of [
    ["fetch", "-q", "--no-tags", dir, head],
    ["update-ref", `refs/heads/${branch}`, head],
  ]) {
    const ran = git(root, args);
    invariant(ran.ok, `git ${args.join(" ")} in the checkout ${root}: ${ran.err}`);
  }
}
