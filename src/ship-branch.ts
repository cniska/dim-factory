import type { CodedError } from "./coded-error";
import { primaryCheckout } from "./git-primary-checkout";
import {
  branchWorktree,
  pairRewrite,
  replayBase,
  restoreBranch,
  startReplay,
  stoppedCommit,
  worktreeClean,
} from "./git-rebase";
import type { Rewrite } from "./git-rebase-contract";
import { nestedRepository } from "./git-tree";
import { reachesTrunk, trunkBranch } from "./git-trunk";
import { fail, type ShipOutcome } from "./ship-contract";
import { shipMethod } from "./ship-method";

export type RebaseVerdict = { land: string[] } | { hold: CodedError };

function rebaseOntoTrunk(root: string, branch: string, trunk: string, tip: string): Rewrite {
  const worktree = branchWorktree(root, branch);
  if (!worktree) throw fail("ship_no_worktree", { branch, root });
  const nested = nestedRepository(worktree);
  if (nested) throw fail("ship_nested_repository", { nested, worktree });
  if (!worktreeClean(worktree)) throw fail("ship_dirty_worktree", { worktree, branch });
  const replay = replayBase(worktree, trunk, tip);
  const step = startReplay(worktree, replay.newBase);
  if ("conflicts" in step) {
    const { oldBase, newBase, oldHead } = replay;
    throw fail("ship_rebase_conflict", {
      branch,
      trunk,
      worktree,
      replay: { oldBase, newBase, oldHead },
      paths: step.conflicts,
      stoppedAt: stoppedCommit(worktree),
    });
  }
  return pairRewrite(replay);
}

function git(dir: string, args: string[]): { success: boolean; out: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return { success: run.success, out: (run.success ? run.stdout : run.stderr).toString().trim() };
}

export function shipBranch(
  cwd: string,
  branch: string,
  shas: string[],
  onRebased: (rewrite: Rewrite) => RebaseVerdict,
): ShipOutcome {
  const root = primaryCheckout(cwd);
  if (!root) throw fail("ship_no_trunk", { reason: `${cwd} is not a git repo that can be read` });
  const declared = shipMethod(root);
  if ("missing" in declared) throw fail("ship_no_method", { reason: declared.missing });
  if ("invalid" in declared) throw fail("ship_invalid_method", { reason: declared.invalid });
  if (declared.method === "pull-request") throw fail("ship_pull_request_unbuilt", { root });

  const trunk = trunkBranch(cwd);
  if ("why" in trunk) throw fail("ship_no_trunk", { reason: trunk.why });

  if (shas.every((sha) => reachesTrunk(cwd, sha).reach === "reached")) {
    return { landed: "already" };
  }

  const head = git(root, ["symbolic-ref", "--short", "HEAD"]);
  if (!head.success || head.out !== trunk.name) throw fail("ship_wrong_head", { root, trunk: trunk.name });
  const status = git(root, ["status", "--porcelain", "--ignore-submodules=dirty"]);
  if (status.out !== "") throw fail("ship_dirty_trunk", { root });

  const tip = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  if (!tip.success) throw fail("ship_no_branch", { root, branch });
  const last = shas.at(-1) as string;
  if (!tip.out.startsWith(last.toLowerCase())) {
    throw fail("ship_unrecorded_head", { branch, tip: tip.out, last });
  }
  const missing = shas.filter((sha) => !git(root, ["merge-base", "--is-ancestor", sha, tip.out]).success);
  if (missing.length > 0) throw fail("ship_not_carried", { branch, trunk: trunk.name, missing });

  let target = tip.out;
  let landing = shas;
  let landed: ShipOutcome["landed"] = "fast_forward";
  if (!git(root, ["merge-base", "--is-ancestor", `refs/heads/${trunk.name}`, tip.out]).success) {
    const rewrite = rebaseOntoTrunk(root, branch, trunk.name, tip.out);
    let verdict: RebaseVerdict;
    try {
      verdict = onRebased(rewrite);
    } catch (error) {
      restoreBranch(rewrite);
      throw error;
    }
    if ("hold" in verdict) throw verdict.hold;
    target = rewrite.newHead;
    landing = verdict.land;
    landed = "rebased";
  }

  if (!git(root, ["merge", "--ff-only", target]).success) {
    throw fail("ship_not_fast_forward", { branch, trunk: trunk.name });
  }

  const unreached = landing.filter((sha) => reachesTrunk(root, sha).reach !== "reached");
  if (unreached.length > 0) throw fail("ship_not_landed", { branch, trunk: trunk.name, unreached });
  return { landed };
}
