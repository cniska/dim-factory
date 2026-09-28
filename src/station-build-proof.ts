import type { SandboxedCheck } from "./check-sandbox";
import { checkedTreeRefusal, git, type TreeRefusal } from "./station-build-tree";
import { proofPin } from "./worktree";

function revision(worktree: string, name: string): string {
  const read = git(worktree, ["rev-parse", "--verify", "-q", name]);
  if (!read.ok) throw new Error(`cannot resolve ${name} in ${worktree}: ${read.err}`);
  return read.out;
}

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
  const unpinned = git(worktree, ["update-ref", "-d", proofPin(orderId)]);
  if (!unpinned.ok) throw new Error(`cannot drop the proof pin of ${orderId}: ${unpinned.err}`);
}

export function settlePinnedSlice(
  worktree: string,
  orderId: string,
): { pin: string; restored: boolean } | null {
  const pinned = git(worktree, ["for-each-ref", "--format=%(objectname)", proofPin(orderId)]);
  if (!pinned.ok) throw new Error(`cannot read the proof pin of ${orderId}: ${pinned.err}`);
  if (pinned.out === "") return null;
  const restored = revision(worktree, `${pinned.out}^`) === revision(worktree, "HEAD");
  if (restored) {
    restoreSlice(worktree, revision(worktree, `${pinned.out}^{tree}`));
    const unstaged = git(worktree, ["reset", "-q"]);
    if (!unstaged.ok) throw new Error(`cannot unstage the restored slice in ${worktree}: ${unstaged.err}`);
  }
  unpin(worktree, orderId);
  return { pin: pinned.out, restored };
}

export function proveTests(options: {
  worktree: string;
  orderId: string;
  tree: string;
  tests: readonly string[];
  check: () => SandboxedCheck;
}): { check: SandboxedCheck; refusal: TreeRefusal | null } {
  const { worktree, orderId, tree } = options;
  const snapshot = git(worktree, [
    "-c",
    "user.name=dim",
    "-c",
    "user.email=dim@localhost",
    "commit-tree",
    "--no-gpg-sign",
    "-p",
    "HEAD",
    "-m",
    `proof pin for ${orderId}`,
    tree,
  ]);
  if (!snapshot.ok)
    throw new Error(`cannot snapshot the slice's tree ${tree} before its proof: ${snapshot.err}`);
  const pinned = git(worktree, ["update-ref", proofPin(orderId), snapshot.out, ""]);
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
