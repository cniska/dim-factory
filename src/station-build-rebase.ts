import type { Database } from "bun:sqlite";
import { CHECK_SANDBOX } from "./check-sandbox";
import { writeTransaction } from "./db";
import {
  changedPaths,
  conflictedPaths,
  continueReplay,
  pairRewrite,
  pathsAddingMarkers,
  rebaseState,
  restoreBranch,
  startReplay,
  stoppedCommit,
  stoppedPaths,
} from "./git-rebase";
import type { Replay } from "./git-rebase-contract";
import { nestedRepository } from "./git-tree";
import { finishAttempt } from "./order-attempt";
import type { RecordedConflict } from "./order-commits";
import { checkRowOf, recordOrderCheck, recordRewrittenCommits } from "./order-evidence";
import { BuildTurnRefused } from "./order-finding";
import { now } from "./order-ledger";
import type { Env } from "./paths";
import { recheck } from "./ship";

function git(worktree: string, args: string[]) {
  const run = Bun.spawnSync(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: run.success, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

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

export function continueRebaseTurn(options: {
  db: Database;
  orderId: string;
  worktree: string;
  conflict: RecordedConflict;
  paths: readonly string[];
  env?: Env;
  checkSandbox?: string[];
}): { conflicts: string[] } | { sha: string } {
  const { db, orderId, worktree, conflict } = options;
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

  const replay: Replay = {
    worktree,
    oldBase: conflict.oldBase,
    newBase: conflict.newBase,
    oldHead: conflict.oldHead,
  };
  const rewrite = pairRewrite(replay);
  let check: ReturnType<typeof recheck>;
  try {
    check = recheck(worktree, env, options.checkSandbox ?? CHECK_SANDBOX);
  } catch (error) {
    restoreBranch(replay);
    throw error;
  }
  if (check.exitCode !== 0) {
    restoreBranch(replay);
    const checkId = recordOrderCheck(db, orderId, checkRowOf(check), rewrite.oldHead);
    throw new BuildTurnRefused(
      "check_failed",
      `${check.command} exited ${check.exitCode} at the rebased head ${rewrite.newHead}; the rebase was taken back and is reopened next turn; its output is on check ${checkId}`,
    );
  }
  writeTransaction(db, () => {
    const at = now();
    recordRewrittenCommits(db, orderId, conflict.shipRun, rewrite, at);
    recordOrderCheck(db, orderId, checkRowOf(check), rewrite.newHead, at);
    finishAttempt(db, orderId, "succeeded", undefined, at);
  });
  return { sha: rewrite.newHead };
}
