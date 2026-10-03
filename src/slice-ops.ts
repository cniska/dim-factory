import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { judge } from "./check-ops";
import { checkTask } from "./declared-tasks";
import { commitsBetween, isAncestor, isClean, tipOf } from "./git";
import { type Conflict, movedCommits } from "./order";
import type { Evidence, Later, StopOf } from "./order-contract";
import { recordAt, recordStop } from "./order-ops";
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

export function submitSlice(db: Database, turn: SliceTurn): { readonly committed: string } {
  const { trace, order, workspace, acting } = turn;
  const tip = tipOf(workspace.dir, workspace.branch);
  const submitted = recordAt(trace, db, {
    order,
    station: "build",
    by: { kind: "worker", acting },
    later: () => ({ action: "slice_submitted", details: { tip } }),
  });
  const { head, conflict, commits } = submitted.state;
  invariant(head !== null, `order ${order} has a recorded head once its workspace is made`);
  const judging: Judging = { trace, db, order, seq: submitted.seq, workspace, tip, head, env: turn.env };
  if (conflict === null) takeCommit(judging);
  else takeRebase(judging, conflict, commits);
  return { committed: tip };
}

type Judging = {
  readonly trace: Trace;
  readonly db: Database;
  readonly order: string;
  readonly seq: number;
  readonly workspace: Workspace;
  readonly tip: string;
  readonly head: string;
  readonly env: Env;
};

function recordJudged({ trace, db, order, seq }: Judging, later: Later): void {
  recordAt(trace, db, { order, station: "build", by: { kind: "factory", cause: seq }, later: () => later });
}

function refuse(judging: Judging, verdict: StopOf<"slice_refused">): never {
  const { trace, order, workspace, tip, head } = judging;
  moveBranch(trace, workspace.dir, workspace.branch, head, tip);
  return recordStop({
    record: (later) => recordJudged(judging, later),
    order,
    stop: verdict,
    refuse: refuseSlice,
  });
}

function checked(judging: Judging): Evidence {
  const { trace, workspace, tip, env } = judging;
  const task = checkTask(workspace.dir);
  if (task === null) return refuse(judging, { action: "slice_refused", code: "no_check", details: { tip } });
  const check = judge(trace, workspace.dir, task.commandLine, env);
  const verdict = checkVerdict(tip, check, isClean(workspace.dir, "all"));
  return verdict === null ? check : refuse(judging, verdict);
}

function takeCommit(judging: Judging): void {
  const { workspace, tip, head } = judging;
  const { dir } = workspace;
  const verdict = submittedVerdict({
    tip,
    head,
    parents: parentsOf(dir, tip),
    checkChanged: checkChanged(dir, tip, head),
    clean: isClean(dir, "all"),
  });
  if (verdict !== null) refuse(judging, verdict);
  recordJudged(judging, {
    action: "slice_committed",
    details: { commit: tip },
    evidence: [checked(judging)],
  });
}

function takeRebase(judging: Judging, { onto }: Conflict, commits: readonly string[]): void {
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
  if (verdict !== null) refuse(judging, verdict);
  recordJudged(judging, {
    action: "branch_rebased",
    details: { head: tip, onto, commits: movedCommits(commits, rebased) },
    evidence: [checked(judging)],
  });
}
