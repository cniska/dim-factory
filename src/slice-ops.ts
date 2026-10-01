import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { judge } from "./check-ops";
import { checkTask } from "./declared-tasks";
import { commitsBetween, isAncestor, isClean, tipOf } from "./git-tree";
import { type Conflict, movedCommits } from "./order";
import type { Evidence } from "./order-contract";
import { recordVerdict, recordWork } from "./order-ops";
import type { Env } from "./paths";
import { checkVerdict, rebasedVerdict, submittedVerdict } from "./slice";
import { refuseSlice, type SliceVerdict } from "./slice-contract";
import { checkChanged, parentsOf } from "./slice-effects";
import type { Trace } from "./trace-contract";
import type { Acting } from "./worker-contract";
import { branchOf } from "./workspace";
import { moveBranch, rebasing } from "./workspace-ops";

export function branchFacts(
  workspace: string,
  order: string,
): { readonly tip: string; readonly clean: boolean } {
  return { tip: tipOf(workspace, branchOf(order)), clean: isClean(workspace, "all") };
}

export function alignBranch(trace: Trace, workspace: string, order: string, head: string): void {
  const branch = branchOf(order);
  const tip = tipOf(workspace, branch);
  if (tip !== head) moveBranch(trace, workspace, branch, head, tip);
}

export type SliceTurn = {
  readonly trace: Trace;
  readonly order: string;
  readonly workspace: string;
  readonly acting: Acting;
  readonly env: Env;
};

export function submitSlice(db: Database, turn: SliceTurn): { readonly committed: string } {
  const { trace, order, workspace, acting } = turn;
  const branch = branchOf(order);
  const tip = tipOf(workspace, branch);
  const submitted = recordWork(trace, db, order, acting, "build", () => ({
    action: "slice_submitted",
    details: { tip },
  }));
  const { head, conflict, commits } = submitted.state;
  invariant(head !== null, `order ${order} has a recorded head once its workspace is made`);
  const judging: Judging = {
    trace,
    db,
    order,
    seq: submitted.seq,
    workspace,
    branch,
    tip,
    head,
    env: turn.env,
  };
  return conflict === null ? takeCommit(judging) : takeRebase(judging, conflict, commits);
}

type Judging = {
  readonly trace: Trace;
  readonly db: Database;
  readonly order: string;
  readonly seq: number;
  readonly workspace: string;
  readonly branch: string;
  readonly tip: string;
  readonly head: string;
  readonly env: Env;
};

function refuse(judging: Judging, verdict: SliceVerdict, evidence: readonly Evidence[]): never {
  const { trace, db, order, seq, workspace, branch, tip, head } = judging;
  recordVerdict(trace, db, order, seq, "build", {
    action: "slice_refused",
    code: verdict.code,
    details: { tip },
    evidence: [...evidence],
  });
  moveBranch(trace, workspace, branch, head, tip);
  throw refuseSlice(verdict.code, { order, tip, ...verdict });
}

function checked(judging: Judging, early: SliceVerdict | null): Evidence {
  if (early !== null) return refuse(judging, early, []);
  const task = checkTask(judging.workspace);
  if (task === null) return refuse(judging, { code: "no_check" }, []);
  const check = judge(judging.trace, judging.workspace, task.commandLine, judging.env);
  const verdict = checkVerdict(check, isClean(judging.workspace, "all"));
  return verdict === null ? check : refuse(judging, verdict, [check]);
}

function takeCommit(judging: Judging): { readonly committed: string } {
  const { trace, db, order, seq, workspace, tip, head } = judging;
  const check = checked(
    judging,
    submittedVerdict({
      head,
      parents: parentsOf(workspace, tip),
      checkChanged: checkChanged(workspace, tip, head),
      clean: isClean(workspace, "all"),
    }),
  );
  recordVerdict(trace, db, order, seq, "build", {
    action: "slice_committed",
    details: { commit: tip },
    evidence: [check],
  });
  return { committed: tip };
}

function takeRebase(
  judging: Judging,
  { onto }: Conflict,
  commits: readonly string[],
): { readonly committed: string } {
  const { trace, db, order, seq, workspace, branch, tip } = judging;
  const rebased = commitsBetween(workspace, onto, tip);
  const check = checked(
    judging,
    rebasedVerdict({
      onto,
      expected: commits.length,
      rebasing: rebasing({ dir: workspace, branch }),
      onOnto: isAncestor(workspace, onto, tip),
      commits: rebased.length,
      checkChanged: checkChanged(workspace, tip, onto),
      clean: isClean(workspace, "all"),
    }),
  );
  recordVerdict(trace, db, order, seq, "build", {
    action: "branch_rebased",
    details: { head: tip, onto, commits: [...movedCommits(commits, rebased)] },
    evidence: [check],
  });
  return { committed: tip };
}
