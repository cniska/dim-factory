import type { SandboxedCheck } from "./check-sandbox";
import { nestedRepository } from "./station-build-tree";

function git(worktree: string, args: string[]): string {
  const run = Bun.spawnSync(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!run.success) {
    throw new Error(`git ${args.join(" ")} failed in ${worktree}: ${run.stderr.toString().trim()}`);
  }
  return run.stdout.toString().trim();
}

function stagedTree(worktree: string): string {
  git(worktree, ["add", "-A"]);
  return git(worktree, ["write-tree"]);
}

function restoreSlice(worktree: string, tree: string): void {
  try {
    git(worktree, ["restore", `--source=${tree}`, "--staged", "--worktree", "--", ":/"]);
    const restored = git(worktree, ["write-tree"]);
    if (restored !== tree) throw new Error(`the index holds tree ${restored}`);
  } catch (error) {
    throw new Error(`the proof could not put back the slice's tree ${tree} in ${worktree}`, { cause: error });
  }
}

export function proveTests(options: {
  worktree: string;
  tree: string;
  tests: readonly string[];
  check: () => SandboxedCheck;
}): { check: SandboxedCheck; nested: string | null; treeChanged: boolean } {
  const { worktree, tree } = options;
  try {
    git(worktree, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ":/"]);
    git(worktree, [
      "restore",
      `--source=${tree}`,
      "--staged",
      "--worktree",
      "--",
      ...options.tests.map((path) => `:(top,literal)${path}`),
    ]);
    const laid = git(worktree, ["write-tree"]);
    const check = options.check();
    const nested = nestedRepository(worktree);
    return { check, nested, treeChanged: nested === null && stagedTree(worktree) !== laid };
  } finally {
    restoreSlice(worktree, tree);
  }
}
