import { primaryCheckout } from "./primary-checkout";
import { shipMethod } from "./ship-method";
import { reachesTrunk, trunkBranch } from "./trunk";

/** How the commits ended up on the trunk. Not a state anything is gated on — the trunk
 *  itself is what `stop completed` reads — only what a caller reports back. */
export type ShipOutcome = { landed: "already" | "fast_forward" };

export type ShipRefusalCode =
  | "ship_no_method"
  | "ship_invalid_method"
  | "ship_pull_request_unbuilt"
  | "ship_no_trunk"
  | "ship_wrong_head"
  | "ship_dirty_trunk"
  | "ship_no_branch"
  | "ship_not_fast_forward"
  | "ship_unsigned"
  | "ship_not_landed";

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
 * Lands `branch`'s commits the way the repo declares in `dim.ship`. Only `trunk` is built:
 * it fast-forwards the trunk, so its history stays linear and every commit lands with the
 * sha the order recorded; a branch the trunk has moved past is refused, to be rebased first.
 *
 * `branch` is always the branch to land — never read off any HEAD, so calling this from
 * the trunk checkout itself cannot be mistaken for shipping the trunk into itself.
 * `cwd` is used only to find the repo and its primary checkout.
 *
 * A returned outcome means every sha in `shas` reaches the trunk, checked back against
 * git rather than assumed from the merge's own exit code: a recorded sha the branch never
 * carried would otherwise ship silently, reported the same as one that actually landed.
 */
export function shipBranch(cwd: string, branch: string, shas: string[]): ShipOutcome {
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

  if (!git(root, ["merge-base", "--is-ancestor", `refs/heads/${trunk.name}`, tip.out]).success) {
    throw new ShipRefusal(
      "ship_not_fast_forward",
      `${trunk.name} has moved past where ${branch} left it; rebase ${branch} onto ${trunk.name} before shipping`,
    );
  }

  // A repository that signs its commits holds every commit the fast-forward brings to that,
  // recorded or not, since a branch can carry commits no order recorded.
  if (git(root, ["config", "--bool", "commit.gpgsign"]).out === "true") {
    const landing = git(root, ["rev-list", `refs/heads/${trunk.name}..${tip.out}`]);
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

  if (!git(root, ["merge", "--ff-only", tip.out]).success) {
    throw new ShipRefusal(
      "ship_not_fast_forward",
      `${branch} could not be fast-forwarded onto ${trunk.name}`,
    );
  }
  const outcome: ShipOutcome = { landed: "fast_forward" };

  const unreached = shas.filter((sha) => reachesTrunk(root, sha).reach !== "reached");
  if (unreached.length > 0) {
    throw new ShipRefusal(
      "ship_not_landed",
      `${branch} landed on ${trunk.name} but does not reach: ${unreached.join(", ")}`,
    );
  }
  return outcome;
}
