import type { SandboxedCheck } from "./check-sandbox";
import { git, nestedRepository, stagedTree } from "./station-build-tree";

function restoreSlice(worktree: string, tree: string): void {
  const fault = (why: string) =>
    new Error(`the proof could not put back the slice's tree ${tree} in ${worktree}: ${why}`);
  const restored = git(worktree, ["restore", `--source=${tree}`, "--staged", "--worktree", "--", ":/"]);
  if (!restored.ok) throw fault(restored.err);
  const written = git(worktree, ["write-tree"]);
  if (!written.ok) throw fault(written.err);
  if (written.out !== tree) throw fault(`the index holds tree ${written.out}`);
}

export function proveTests(options: {
  worktree: string;
  tree: string;
  tests: readonly string[];
  check: () => SandboxedCheck;
}): { check: SandboxedCheck; nested: string | null; treeChanged: boolean } {
  const { worktree, tree } = options;
  try {
    const based = git(worktree, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ":/"]);
    if (!based.ok) throw new Error(`the proof could not put ${worktree} back at HEAD: ${based.err}`);
    const laid = git(worktree, [
      "restore",
      `--source=${tree}`,
      "--staged",
      "--worktree",
      "--",
      ...options.tests.map((path) => `:(top,literal)${path}`),
    ]);
    if (!laid.ok)
      throw new Error(`the proof could not lay the named tests over HEAD in ${worktree}: ${laid.err}`);
    const laidTree = git(worktree, ["write-tree"]);
    if (!laidTree.ok)
      throw new Error(`the proof could not read the laid tree of ${worktree}: ${laidTree.err}`);
    const check = options.check();
    const nested = nestedRepository(worktree);
    return { check, nested, treeChanged: nested === null && stagedTree(worktree) !== laidTree.out };
  } finally {
    restoreSlice(worktree, tree);
  }
}
