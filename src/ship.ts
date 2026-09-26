import { primaryCheckout } from "./git-primary-checkout";
import { reachesTrunk, trunkBranch } from "./git-trunk";
import { shipMethod } from "./ship-method";
import { type Rewrite, rebaseOntoTrunk, restoreBranch } from "./ship-rebase";
import { ShipRefusal } from "./ship-refusal";

export type ShipOutcome = { landed: "already" | "fast_forward" | "rebased" };

export type RebaseVerdict = { land: string[] } | { hold: ShipRefusal };

function git(dir: string, args: string[]): { success: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return { success: run.success, out: (run.success ? run.stdout : run.stderr).toString().trim() };
}

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

export function shipBranch(
  cwd: string,
  branch: string,
  shas: string[],
  onRebased: (rewrite: Rewrite) => RebaseVerdict,
): ShipOutcome {
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
  const status = git(root, ["status", "--porcelain", "--ignore-submodules=dirty"]);
  if (status.out !== "") {
    throw new ShipRefusal(
      "ship_dirty_trunk",
      `${root} has uncommitted changes or a moved submodule; commit or discard them before shipping`,
    );
  }

  const tip = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  if (!tip.success) {
    throw new ShipRefusal("ship_no_branch", `${root} has no branch named ${branch} to ship`);
  }
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
