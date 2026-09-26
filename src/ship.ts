import { primaryCheckout } from "./primary-checkout";
import { type Rewrite, rebaseOntoTrunk, restoreBranch } from "./rebase-onto-trunk";
import { shipMethod } from "./ship-method";
import { ShipRefusal } from "./ship-refusal";
import { reachesTrunk, trunkBranch } from "./trunk";

/** How the commits ended up on the trunk. Not a state anything is gated on — the trunk
 *  itself is what `stop completed` reads — only what a caller reports back. */
export type ShipOutcome = { landed: "already" | "fast_forward" | "rebased" };

/** What the caller decides once a rebase has replayed cleanly: the shas that must reach the trunk,
 *  or a refusal that keeps the rewritten branch as it is. Throwing instead takes the rebase back. */
export type RebaseVerdict = { land: string[] } | { hold: ShipRefusal };

function git(dir: string, args: string[]): { success: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return { success: run.success, out: (run.success ? run.stdout : run.stderr).toString().trim() };
}

/** A repository that signs its commits holds every commit a fast-forward to `head` brings to that,
 *  recorded or not, since a branch can carry commits no order recorded. */
function refuseUnsigned(root: string, branch: string, trunk: string, head: string): void {
  if (git(root, ["config", "--bool", "commit.gpgsign"]).out !== "true") return;
  const landing = git(root, ["rev-list", `refs/heads/${trunk}..${head}`]);
  if (!landing.success) {
    throw new ShipRefusal("ship_unsigned", `cannot list what ${branch} would land: ${landing.out}`);
  }
  const unsigned = landing.out
    .split("\n")
    .filter(Boolean)
    .filter((sha) => !git(root, ["verify-commit", sha]).success);
  if (unsigned.length > 0) {
    throw new ShipRefusal(
      "ship_unsigned",
      `${root} signs its commits, and ${branch} carries some that do not verify: ${unsigned.join(", ")}`,
    );
  }
}

/**
 * Lands `branch`'s commits the way the repo declares in `dim.ship`. Only `trunk` is built:
 * it fast-forwards the trunk, so its history stays linear. A branch the trunk has moved past
 * is first rebased onto it, and `onRebased` decides what then lands; everything else lands
 * with the sha the order recorded.
 *
 * `branch` is always the branch to land — never read off any HEAD, so calling this from
 * the trunk checkout itself cannot be mistaken for shipping the trunk into itself.
 * `cwd` is used only to find the repo and its primary checkout.
 *
 * A returned outcome means every sha that had to land reaches the trunk, checked back against
 * git rather than assumed from the merge's own exit code: a recorded sha the branch never
 * carried would otherwise ship silently, reported the same as one that actually landed.
 */
export function shipBranch(
  cwd: string,
  branch: string,
  shas: string[],
  onRebased: (rewrite: Rewrite) => RebaseVerdict,
): ShipOutcome {
  // Merging happens in the primary checkout, because moving a branch ref without updating
  // the tree that has it checked out leaves that checkout's files disagreeing with its HEAD.
  const root = primaryCheckout(cwd);
  if (!root) throw new ShipRefusal("ship_no_trunk", `${cwd} is not a git repo that can be read`);
  const declared = shipMethod(root);
  if ("missing" in declared) throw new ShipRefusal("ship_no_method", declared.missing);
  if ("invalid" in declared) throw new ShipRefusal("ship_invalid_method", declared.invalid);
  if (declared.method === "pull-request") {
    throw new ShipRefusal(
      "ship_pull_request_unbuilt",
      `${root} declares dim.ship = pull-request, and shipping by pull request is not built`,
    );
  }

  const trunk = trunkBranch(cwd);
  if ("why" in trunk) throw new ShipRefusal("ship_no_trunk", trunk.why);

  if (shas.every((sha) => reachesTrunk(cwd, sha).reach === "reached")) {
    return { landed: "already" };
  }

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

  // Read once, as a sha: a bare name can resolve to a tag first, and a ref read again later can
  // have moved, so everything checked below is the one commit the trunk is moved to.
  const tip = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  if (!tip.success) {
    throw new ShipRefusal("ship_no_branch", `${root} has no branch named ${branch} to ship`);
  }
  // A tip the order never recorded is one no recorded check passed — a commit made outside the
  // runner, or a rebase interrupted before it was recorded — and the trunk must not move to it.
  if (!shas.some((sha) => tip.out.startsWith(sha.toLowerCase()))) {
    throw new ShipRefusal(
      "ship_unrecorded_head",
      `${branch} is at ${tip.out}, which is none of the commits the order recorded; reset it to the order's last recorded commit or record it first`,
    );
  }

  let target = tip.out;
  let landing = shas;
  let landed: ShipOutcome["landed"] = "fast_forward";
  if (git(root, ["merge-base", "--is-ancestor", `refs/heads/${trunk.name}`, tip.out]).success) {
    refuseUnsigned(root, branch, trunk.name, target);
  } else {
    // A branch the trunk already contains has nothing to replay, so a recorded sha still off the
    // trunk is one the branch never carried.
    if (git(root, ["merge-base", "--is-ancestor", tip.out, `refs/heads/${trunk.name}`]).success) {
      const unreached = shas.filter((sha) => reachesTrunk(root, sha).reach !== "reached");
      throw new ShipRefusal(
        "ship_not_landed",
        `${trunk.name} already carries ${branch}, which does not reach: ${unreached.join(", ")}`,
      );
    }
    const rewrite = rebaseOntoTrunk(root, branch, trunk.name, tip.out);
    let verdict: RebaseVerdict;
    try {
      refuseUnsigned(root, branch, trunk.name, rewrite.newHead);
      verdict = onRebased(rewrite);
    } catch (error) {
      try {
        restoreBranch(rewrite);
      } catch (restoring) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${(restoring as Error).message}; the ship was refused first: ${reason}`, {
          cause: error,
        });
      }
      throw error;
    }
    if ("hold" in verdict) throw verdict.hold;
    target = rewrite.newHead;
    landing = verdict.land;
    landed = "rebased";
  }

  if (!git(root, ["merge", "--ff-only", target]).success) {
    throw new ShipRefusal(
      "ship_not_fast_forward",
      `${branch} could not be fast-forwarded onto ${trunk.name}`,
    );
  }

  const unreached = landing.filter((sha) => reachesTrunk(root, sha).reach !== "reached");
  if (unreached.length > 0) {
    throw new ShipRefusal(
      "ship_not_landed",
      `${branch} landed on ${trunk.name} but does not reach: ${unreached.join(", ")}`,
    );
  }
  return { landed };
}
