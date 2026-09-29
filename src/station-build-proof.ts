import type { SandboxedCheck } from "./check-sandbox";
import type { CodedError } from "./coded-error";
import { git } from "./git-tree";
import { checkedTreeRefusal } from "./station-build-tree";

function putBack(worktree: string): void {
  const restored = git(worktree, ["reset", "-q", "--hard", "HEAD"]);
  if (!restored.ok)
    throw new Error(`the proof could not put ${worktree} back at its commit: ${restored.err}`);
}

export function proveTests(options: {
  worktree: string;
  tests: readonly string[];
  base: string;
  check: () => SandboxedCheck;
}): { check: SandboxedCheck; refusal: CodedError | null } {
  const { worktree } = options;
  try {
    const based = git(worktree, [
      "restore",
      "--source=HEAD^",
      "--staged",
      "--worktree",
      "--",
      ":/",
      ":(top,exclude,glob)**/.gitignore",
    ]);
    if (!based.ok)
      throw new Error(`the proof could not put ${worktree} at its commit's parent: ${based.err}`);
    const laid = git(worktree, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ...options.tests.map((path) => `:(top,literal)${path}`),
    ]);
    if (!laid.ok)
      throw new Error(`the proof could not lay the named tests over the parent in ${worktree}: ${laid.err}`);
    const laidTree = git(worktree, ["write-tree"]);
    if (!laidTree.ok)
      throw new Error(`the proof could not read the laid tree of ${worktree}: ${laidTree.err}`);
    const check = options.check();
    return {
      check,
      refusal: checkedTreeRefusal(worktree, laidTree.out, check.command, {
        tests: options.tests,
        base: options.base,
      }),
    };
  } finally {
    putBack(worktree);
  }
}
