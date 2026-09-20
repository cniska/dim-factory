import { dirname } from "node:path";
import { reachesTrunk, trunkBranch } from "./trunk";

/** How the commits ended up on the trunk. Not a state anything is gated on — the trunk
 *  itself is what `stop completed` reads — only what a caller reports back. */
export type ShipOutcome = { landed: "already" | "fast_forward" | "merged" };

export type ShipRefusalCode =
  | "ship_no_trunk"
  | "ship_wrong_head"
  | "ship_dirty_trunk"
  | "ship_no_branch"
  | "ship_conflict";

/** Carries a code because a caller deciding which condition failed must not match on prose. */
export class ShipRefusal extends Error {
  constructor(
    readonly code: ShipRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

function git(dir: string, args: string[]): { success: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return { success: run.success, out: (run.success ? run.stdout : run.stderr).toString().trim() };
}

/**
 * The main working tree even from a task worktree: `--git-common-dir` resolves to the
 * shared `.git`, whose parent is the checkout the trunk branch is worked from — merging
 * has to happen there, because moving a branch ref without updating the tree that has it
 * checked out leaves that checkout's files disagreeing with its own HEAD.
 */
function primaryCheckout(dir: string): string {
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.success) throw new ShipRefusal("ship_no_trunk", `${dir} is not a git repo that can be read`);
  return dirname(common.out);
}

/**
 * Lands `branch`'s commits on the repo's trunk without rewriting them: a fast-forward
 * where one reaches, an ordinary merge commit otherwise, and never a rebase or a squash,
 * since either would give the order's commits a new sha and fail their own completion gate.
 *
 * `branch` is always the branch to land — never read off any HEAD, so calling this from
 * the trunk checkout itself cannot be mistaken for shipping the trunk into itself.
 * `cwd` is used only to find the repo and its primary checkout.
 *
 * Only the local flow a repo with no remote can be tested against: opening a pull request
 * instead is a second flow this leaves reachable rather than one it builds ahead of a
 * caller that needs it.
 */
export function shipToTrunk(cwd: string, branch: string, shas: string[]): ShipOutcome {
  const trunk = trunkBranch(cwd);
  if ("why" in trunk) throw new ShipRefusal("ship_no_trunk", trunk.why);

  if (shas.map((sha) => reachesTrunk(cwd, sha)).some((reach) => reach.reach === "reached")) {
    return { landed: "already" };
  }

  const root = primaryCheckout(cwd);
  const head = git(root, ["symbolic-ref", "--short", "HEAD"]);
  if (!head.success || head.out !== trunk.name) {
    throw new ShipRefusal(
      "ship_wrong_head",
      `${root} is not checked out on ${trunk.name}; check it out there before shipping`,
    );
  }
  const status = git(root, ["status", "--porcelain"]);
  if (status.out !== "") {
    throw new ShipRefusal(
      "ship_dirty_trunk",
      `${root} has uncommitted changes; commit or stash them before shipping`,
    );
  }

  if (!git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).success) {
    throw new ShipRefusal("ship_no_branch", `${root} has no branch named ${branch} to ship`);
  }

  if (git(root, ["merge", "--ff-only", branch]).success) return { landed: "fast_forward" };
  const merge = git(root, ["merge", "--no-edit", branch]);
  if (!merge.success) {
    git(root, ["merge", "--abort"]);
    throw new ShipRefusal("ship_conflict", `merging ${branch} into ${trunk.name} failed: ${merge.out}`);
  }
  return { landed: "merged" };
}
