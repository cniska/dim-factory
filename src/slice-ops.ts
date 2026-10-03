import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { judge } from "./check-ops";
import { checkTask } from "./declared-tasks";
import { commitsBetween, isAncestor, isClean, tipOf } from "./git";
import { type Conflict, movedCommits, type Submitted } from "./order";
import type { Evidence, Later, StopOf } from "./order-contract";
import { orderState, recordAt } from "./order-ops";
import type { Env } from "./paths";
import { checkVerdict, rebasedVerdict, submittedVerdict } from "./slice";
import { refuseSlice } from "./slice-contract";
import { checkChanged, parentsOf } from "./slice-effects";
import type { Trace } from "./trace-contract";
import type { Acting } from "./worker-contract";
import type { Workspace } from "./workspace";
import { moveBranch, rebasing } from "./workspace-ops";

export type SliceTurn = {
  readonly trace: Trace;
  readonly order: string;
  readonly workspace: Workspace;
  readonly acting: Acting;
  readonly env: Env;
};

type Refused = StopOf<"slice_refused">;

export function submitSlice(db: Database, turn: SliceTurn): { readonly committed: string } {
  const { trace, order, workspace, acting } = turn;
  const tip = tipOf(workspace.dir, workspace.branch);
  const submitted = recordAt(trace, db, {
    order,
    station: "build",
    by: { kind: "worker", acting },
    later: () => ({ action: "slice_submitted", details: { tip } }),
  });
  const refused = settleSubmission(
    db,
    { trace, order, workspace, env: turn.env },
    { seq: submitted.seq, tip },
  );
  if (refused !== null) throw refuseSlice(refused.code, { order, ...refused.details });
  return { committed: tip };
}

export type Settling = {
  readonly trace: Trace;
  readonly order: string;
  readonly workspace: Workspace;
  readonly env: Env;
};

export function settleSubmission(db: Database, settling: Settling, { seq, tip }: Submitted): Refused | null {
  const { head, conflict, commits } = orderState(db, settling.order);
  invariant(head !== null, `order ${settling.order} has a recorded head once its workspace is made`);
  const judging: Judging = { ...settling, db, seq, tip, head };
  return conflict === null ? takeCommit(judging) : takeRebase(judging, conflict, commits);
}

type Judging = Settling & {
  readonly db: Database;
  readonly seq: number;
  readonly tip: string;
  readonly head: string;
};

function recordJudged({ trace, db, order, seq }: Judging, later: Later): void {
  recordAt(trace, db, { order, station: "build", by: { kind: "factory", cause: seq }, later: () => later });
}

function refuse(judging: Judging, verdict: Refused): Refused {
  const { trace, workspace, tip, head } = judging;
  moveBranch(trace, workspace.dir, workspace.branch, head, tip);
  recordJudged(judging, verdict);
  return verdict;
}

function checked(judging: Judging): Evidence | Refused {
  const { trace, workspace, tip, env } = judging;
  const task = checkTask(workspace.dir);
  if (task === null) return refuse(judging, { action: "slice_refused", code: "no_check", details: { tip } });
  const check = judge(trace, workspace.dir, task.commandLine, env);
  const verdict = checkVerdict(tip, check, isClean(workspace.dir, "all"));
  return verdict === null ? check : refuse(judging, verdict);
}

function takeCommit(judging: Judging): Refused | null {
  const { workspace, tip, head } = judging;
  const { dir } = workspace;
  const verdict = submittedVerdict({
    tip,
    head,
    parents: parentsOf(dir, tip),
    checkChanged: checkChanged(dir, tip, head),
    clean: isClean(dir, "all"),
  });
  if (verdict !== null) return refuse(judging, verdict);
  const evidence = checked(judging);
  if ("action" in evidence) return evidence;
  recordJudged(judging, { action: "slice_committed", details: { commit: tip }, evidence: [evidence] });
  return null;
}

function takeRebase(judging: Judging, { onto }: Conflict, commits: readonly string[]): Refused | null {
  const { workspace, tip } = judging;
  const { dir } = workspace;
  const rebased = commitsBetween(dir, onto, tip);
  const verdict = rebasedVerdict({
    tip,
    onto,
    expected: commits.length,
    rebasing: rebasing(workspace),
    onOnto: isAncestor(dir, onto, tip),
    commits: rebased.length,
    checkChanged: checkChanged(dir, tip, onto),
    clean: isClean(dir, "all"),
  });
  if (verdict !== null) return refuse(judging, verdict);
  const evidence = checked(judging);
  if ("action" in evidence) return evidence;
  recordJudged(judging, {
    action: "branch_rebased",
    details: { head: tip, onto, commits: movedCommits(commits, rebased) },
    evidence: [evidence],
  });
  return null;
}
