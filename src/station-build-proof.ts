import type { SandboxedCheck } from "./check-sandbox";
import { checkedTreeRefusal, git, type TreeRefusal } from "./station-build-tree";

const pinOf = (orderId: string): string => `refs/dim/proof/${orderId}`;

function restoreSlice(worktree: string, tree: string): void {
  const fault = (why: string) =>
    new Error(`the proof could not put back the slice's tree ${tree} in ${worktree}: ${why}`);
  const restored = git(worktree, ["restore", `--source=${tree}`, "--staged", "--worktree", "--", ":/"]);
  if (!restored.ok) throw fault(restored.err);
  const written = git(worktree, ["write-tree"]);
  if (!written.ok) throw fault(written.err);
  if (written.out !== tree) throw fault(`the index holds tree ${written.out}`);
}

function unpin(worktree: string, orderId: string): void {
  const unpinned = git(worktree, ["update-ref", "-d", pinOf(orderId)]);
  if (!unpinned.ok) throw new Error(`cannot drop the proof pin of ${orderId}: ${unpinned.err}`);
}

export function restorePinnedSlice(worktree: string, orderId: string): string | null {
  const pinned = git(worktree, ["for-each-ref", "--format=%(objectname)", pinOf(orderId)]);
  if (!pinned.ok) throw new Error(`cannot read the proof pin of ${orderId}: ${pinned.err}`);
  if (pinned.out === "") return null;
  restoreSlice(worktree, pinned.out);
  const unstaged = git(worktree, ["reset", "-q"]);
  if (!unstaged.ok) throw new Error(`cannot unstage the restored slice in ${worktree}: ${unstaged.err}`);
  unpin(worktree, orderId);
  return pinned.out;
}

export function proveTests(options: {
  worktree: string;
  orderId: string;
  tree: string;
  tests: readonly string[];
  check: () => SandboxedCheck;
}): { check: SandboxedCheck; refusal: TreeRefusal | null } {
  const { worktree, orderId, tree } = options;
  const pinned = git(worktree, ["update-ref", pinOf(orderId), tree, ""]);
  if (!pinned.ok) throw new Error(`cannot pin the slice's tree ${tree} before its proof: ${pinned.err}`);
  try {
    const based = git(worktree, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ":/",
      ":(top,exclude,glob)**/.gitignore",
    ]);
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
    return { check, refusal: checkedTreeRefusal(worktree, laidTree.out, check.command) };
  } finally {
    restoreSlice(worktree, tree);
    unpin(worktree, orderId);
  }
}
