import type { Database } from "bun:sqlite";
import { BuildTurnRefused } from "./builder-commit";
import { nestedRepository } from "./builder-tree";
import {
  isActiveOrderRun,
  moveOrder,
  type RecordedConflict,
  recheck,
  recordOrderCheck,
  recordOrderRewrite,
} from "./factory-order";
import type { Env } from "./paths";
import {
  changedPaths,
  conflictedPaths,
  continueReplay,
  pairRewrite,
  pathsAddingMarkers,
  type Replay,
  rebaseState,
  restoreBranch,
  startReplay,
  stoppedCommit,
  stoppedPaths,
} from "./rebase-onto-trunk";
import { CHECK_SANDBOX } from "./sandboxed-check";

function git(worktree: string, args: string[]) {
  const run = Bun.spawnSync(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: run.success, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

/** The rebase in progress is the one the conflict recorded, or the builder's resolution would be
 *  continued into a rebase nothing recorded. */
function assertRecordedRebase(worktree: string, orderId: string, conflict: RecordedConflict): void {
  const state = rebaseState(worktree);
  if (
    state?.origHead !== conflict.oldHead ||
    state.onto !== conflict.newBase ||
    state.headName !== `refs/heads/${orderId}`
  ) {
    throw new BuildTurnRefused(
      "rebase_mismatch",
      `${worktree} is not mid-rebase of ${orderId} from ${conflict.oldHead} onto ${conflict.newBase}, the rebase its ship recorded`,
    );
  }
}

/**
 * The rebase a conflict turn resolves: the one in progress, checked against the record, or, where
 * an earlier turn's red check took it back, the branch at the recorded head replayed again onto
 * the recorded base. Returns the paths the stop left unmerged; where they were staged since, the
 * recorded paths at the commit the ship stopped on, and every path a later stop may hold a
 * conflict in.
 */
export function reopenRebase(worktree: string, orderId: string, conflict: RecordedConflict): string[] {
  if (rebaseState(worktree) !== null) {
    assertRecordedRebase(worktree, orderId, conflict);
    const unmerged = conflictedPaths(worktree);
    if (unmerged.length > 0) return unmerged;
    return stoppedCommit(worktree) === conflict.stoppedAt ? conflict.paths : stoppedPaths(worktree);
  }
  const branch = git(worktree, ["symbolic-ref", "-q", "HEAD"]).out;
  const head = git(worktree, ["rev-parse", "HEAD"]).out;
  if (branch !== `refs/heads/${orderId}` || head !== conflict.oldHead) {
    throw new BuildTurnRefused(
      "rebase_mismatch",
      `${worktree} is at ${branch || "a detached HEAD"} ${head}, not refs/heads/${orderId} at ${conflict.oldHead}, the head its ship recorded`,
    );
  }
  const nested = nestedRepository(worktree);
  if (nested) {
    throw new BuildTurnRefused(
      "nested_repository",
      `${nested} is a git repository inside the worktree, which a rebase there would run git in`,
    );
  }
  const step = startReplay(worktree, conflict.newBase);
  if ("done" in step) {
    restoreBranch({ worktree, oldHead: conflict.oldHead });
    throw new Error(`the conflict recorded for ${orderId} did not recur when its rebase was reopened`);
  }
  return step.conflicts;
}

/**
 * The runner's path for a build turn that resolved a rebase conflict, kept apart from
 * `commitBuildTurn` because it continues a rebase rather than making a commit. It refuses a
 * resolution that adds a conflict marker to one of `paths`, the ones the rebase stopped in, or
 * that leaves the replayed commit empty, before anything is staged, so a refused turn leaves the
 * stop as the next turn needs it; then it stages what the builder left and continues the rebase.
 * A later commit that conflicts comes back as its paths, for the builder to resolve next. A
 * finished rebase is re-checked in the check sandbox and recorded as a rewrite that kept no patch,
 * since the builder wrote part of it, and the order returns to review to read it whole. A red check
 * takes the rebase back, and the next turn reopens it.
 */
export function continueRebaseTurn(options: {
  db: Database;
  orderId: string;
  runId: string;
  operator: string;
  worktree: string;
  conflict: RecordedConflict;
  paths: readonly string[];
  env?: Env;
  checkSandbox?: string[];
}): { conflicts: string[] } | { sha: string } {
  const { db, orderId, operator, worktree, conflict } = options;
  const env = options.env ?? process.env;
  assertRecordedRebase(worktree, orderId, conflict);
  const nested = nestedRepository(worktree);
  if (nested) {
    throw new BuildTurnRefused(
      "nested_repository",
      `${nested} is a git repository inside the worktree, which the runner does not stage`,
    );
  }
  const unresolved = pathsAddingMarkers(worktree, options.paths);
  if (unresolved.length > 0) {
    throw new BuildTurnRefused(
      "conflict_unresolved",
      `the resolution still carries conflict markers in ${unresolved.join(", ")}, so the rebase was not continued`,
    );
  }
  // An empty commit has nothing to pair with the one it replaces, and git will not continue one.
  if (
    changedPaths(worktree).length === 0 &&
    git(worktree, ["ls-files", "-o", "--exclude-standard"]).out === ""
  ) {
    throw new BuildTurnRefused(
      "conflict_unresolved",
      `the resolution leaves the replayed commit empty, dropping the order's change in ${options.paths.join(", ")}; keep that change alongside the trunk's`,
    );
  }
  const staged = git(worktree, ["add", "-A"]);
  if (!staged.ok) throw new Error(`cannot stage ${worktree}: ${staged.err}`);
  const step = continueReplay(worktree);
  if ("conflicts" in step) return step;

  const replay: Replay = { worktree, ...conflict };
  const rewrite = { ...pairRewrite(replay), patchEqual: false };
  let check: ReturnType<typeof recheck>;
  try {
    check = recheck(worktree, env, options.checkSandbox ?? CHECK_SANDBOX);
  } catch (error) {
    restoreBranch(replay);
    throw error;
  }
  if (check.exitCode !== 0) {
    restoreBranch(replay);
    recordOrderCheck(db, orderId, check, operator);
    throw new BuildTurnRefused(
      "check_failed",
      `${check.command} exited ${check.exitCode} at the rebased head ${rewrite.newHead}; the rebase was taken back and is reopened next turn:\n${check.result}`,
    );
  }
  // A long check leaves time for the order to be stopped, moved or taken by another run.
  if (!isActiveOrderRun(db, orderId, options.runId)) {
    restoreBranch(replay);
    throw new BuildTurnRefused(
      "order_not_building",
      `order ${orderId} is no longer held by run ${options.runId} after its check ran`,
    );
  }
  db.transaction(() => {
    recordOrderRewrite(db, orderId, rewrite, check, operator);
    moveOrder(db, orderId, "dim-station-review", operator);
  })();
  return { sha: rewrite.newHead };
}
