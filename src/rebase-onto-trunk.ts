import { existsSync } from "node:fs";
import { hooksOutsideTree, nestedRepository } from "./builder-tree";
import { ShipRefusal } from "./ship-refusal";

export type Rewrite = {
  worktree: string;
  oldBase: string;
  newBase: string;
  oldHead: string;
  newHead: string;
  /** Every replayed commit, old sha to new, in branch order. */
  commits: { from: string; to: string }[];
  patchEqual: boolean;
};

function git(dir: string, args: string[]): { ok: boolean; out: string; err: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: run.success, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

function read(dir: string, args: string[]): string {
  const run = git(dir, args);
  if (!run.ok) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${run.err}`);
  return run.out;
}

/** A rebase moves the branch and the files checked out from it together, so it runs where the branch is checked out. */
function branchWorktree(root: string, branch: string): string | null {
  const records = read(root, ["worktree", "list", "--porcelain", "-z"]).split("\0\0");
  for (const record of records) {
    const fields = record.split("\0");
    if (fields.includes(`branch refs/heads/${branch}`)) {
      return fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length) ?? null;
    }
  }
  return null;
}

function commitsIn(dir: string, base: string, head: string): string[] {
  return read(dir, ["rev-list", "--reverse", `${base}..${head}`])
    .split("\n")
    .filter(Boolean);
}

/**
 * Whether `git range-diff` paired every commit with one carrying the same patch. Its pair lines
 * start at the margin, padded only to the width of the largest commit number, while the
 * patch-of-patches it prints under a changed pair is indented by four.
 */
export function patchesEqual(rangeDiff: string): boolean {
  const pairs = rangeDiff
    .split("\n")
    .map((line) => /^ {0,3}(?:\d+|-+): +(?:[0-9a-f]+|-+) ([=!<>]) /.exec(line)?.[1])
    .filter((mark) => mark !== undefined);
  return pairs.length > 0 && pairs.every((mark) => mark === "=");
}

/** Puts the branch and its worktree back where the rebase found them. */
export function restoreBranch(rewrite: Pick<Rewrite, "worktree" | "oldHead">): void {
  const reset = git(rewrite.worktree, ["reset", "-q", "--hard", rewrite.oldHead]);
  if (!reset.ok) {
    throw new Error(
      `the rebase could not be taken back, so ${rewrite.worktree} is not at ${rewrite.oldHead}: ${reset.err}`,
    );
  }
}

/**
 * Replays `branch` onto the trunk's tip in the worktree it is checked out in. Git runs the
 * repository's own config there, as the operator, over files the builder wrote, so a repository
 * nested in the tree is refused before any status could run inside it, and the hooks come from
 * outside the tree. Every commit is replayed, including one already on the trunk or left empty,
 * so each recorded commit has exactly one successor. A refusal leaves the branch where it was.
 */
export function rebaseOntoTrunk(root: string, branch: string, trunk: string, tip: string): Rewrite {
  const worktree = branchWorktree(root, branch);
  if (!worktree) {
    throw new ShipRefusal(
      "ship_no_worktree",
      `${branch} is not checked out in any worktree of ${root}, so there is nowhere to rebase it`,
    );
  }
  const nested = nestedRepository(worktree);
  if (nested) {
    throw new ShipRefusal(
      "ship_nested_repository",
      `${nested} is a git repository inside ${worktree}, which a rebase there would run git in`,
    );
  }
  if (read(worktree, ["status", "--porcelain"]) !== "") {
    throw new ShipRefusal(
      "ship_dirty_worktree",
      `${worktree} has uncommitted changes, which a rebase of ${branch} would have to carry`,
    );
  }
  const oldBase = read(worktree, ["merge-base", `refs/heads/${trunk}`, tip]);
  const newBase = read(worktree, ["rev-parse", `refs/heads/${trunk}^{commit}`]);
  const rebase = git(worktree, [
    "-c",
    `core.hooksPath=${hooksOutsideTree(worktree)}`,
    "rebase",
    "--quiet",
    "--reapply-cherry-picks",
    "--empty=keep",
    "--no-autosquash",
    "--no-autostash",
    newBase,
  ]);
  if (!rebase.ok) {
    const listed = git(worktree, [
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      "--diff-filter=U",
      "-z",
    ]);
    const gitDir = read(worktree, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    if (existsSync(`${gitDir}/rebase-merge`) || existsSync(`${gitDir}/rebase-apply`)) {
      const abort = git(worktree, ["rebase", "--abort"]);
      if (!abort.ok) throw new Error(`the rebase of ${branch} could not be aborted: ${abort.err}`);
    }
    if (!listed.ok) {
      throw new Error(`the rebase of ${branch} stopped and its conflicts could not be listed: ${listed.err}`);
    }
    const conflicted = listed.out.split("\0").filter(Boolean);
    if (conflicted.length > 0) {
      throw new ShipRefusal(
        "ship_rebase_conflict",
        `${branch} conflicts with ${trunk} in ${conflicted.join(", ")}; the rebase was aborted`,
      );
    }
    throw new ShipRefusal(
      "ship_rebase_failed",
      `git could not rebase ${branch} onto ${trunk}: ${rebase.err}`,
    );
  }

  const newHead = read(worktree, ["rev-parse", "HEAD"]);
  const from = commitsIn(worktree, oldBase, tip);
  const to = commitsIn(worktree, newBase, newHead);
  if (from.length !== to.length) {
    restoreBranch({ worktree, oldHead: tip });
    throw new ShipRefusal(
      "ship_rebase_unpaired",
      `rebasing ${branch} turned ${from.length} commits into ${to.length}, so no replayed commit can be paired with the one it replaced; the rebase was taken back`,
    );
  }
  const rangeDiff = git(worktree, [
    "range-diff",
    "--no-color",
    `${oldBase}..${tip}`,
    `${newBase}..${newHead}`,
  ]);
  if (!rangeDiff.ok) {
    restoreBranch({ worktree, oldHead: tip });
    throw new Error(`git range-diff could not compare the rebase of ${branch}: ${rangeDiff.err}`);
  }
  return {
    worktree,
    oldBase,
    newBase,
    oldHead: tip,
    newHead,
    commits: from.map((sha, index) => ({ from: sha, to: to[index] as string })),
    patchEqual: patchesEqual(rangeDiff.out),
  };
}
