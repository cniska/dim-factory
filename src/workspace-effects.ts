import { rmSync } from "node:fs";
import { invariant } from "./assert";
import { git, ran } from "./git-tree";
import { refuseWorkspace } from "./workspace-contract";

const WORKSPACE_CONFIG = [
  ["core.hooksPath", ""],
  ["commit.gpgsign", "false"],
  ["gc.auto", "0"],
] as const;

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
    const step = git(cwd, [...args]);
    if (!step.ok) throw refuseWorkspace("workspace_failed", { dir, detail: step.err });
  }
}

export function publishHead(root: string, dir: string, branch: string, head: string): void {
  ran(root, ["fetch", "-q", "--no-tags", dir, head]);
  ran(root, ["update-ref", `refs/heads/${branch}`, head]);
}

export function resetTo(dir: string, root: string, branch: string, head: string): void {
  ran(dir, ["fetch", "-q", "--no-tags", root, head]);
  ran(dir, ["update-ref", `refs/heads/${branch}`, head]);
  ran(dir, ["reset", "-q", "--hard", head]);
}

export function spreadTree(dir: string, tree: string): void {
  ran(dir, ["read-tree", "--reset", "-u", tree]);
  ran(dir, ["reset", "-q"]);
}

export function removeDir(dir: string): string | null {
  try {
    rmSync(dir, { recursive: true });
    return null;
  } catch (error) {
    return String(error);
  }
}

export function deleteBranch(root: string, branch: string): string | null {
  const deleted = git(root, ["update-ref", "-d", `refs/heads/${branch}`]);
  return deleted.ok ? null : deleted.err;
}
