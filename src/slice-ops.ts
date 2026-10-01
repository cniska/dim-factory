import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { judge } from "./check-ops";
import { checkTask } from "./declared-tasks";
import { commitsBetween, isAncestor, isClean, moveRef, tipOf } from "./git-tree";
import { movedCommits } from "./order";
import type { Evidence } from "./order-contract";
import { recordVerdict, recordWork } from "./order-ops";
import type { Env } from "./paths";
import { checkVerdict, rebasedVerdict, submittedVerdict } from "./slice";
import { refuseSlice, type SliceVerdict } from "./slice-contract";
import { checkChanged, parentsOf } from "./slice-effects";
import type { Acting } from "./worker-contract";
import { branchOf } from "./workspace";
import { workspaceRebasing } from "./workspace-ops";

export function branchFacts(
  workspace: string,
  order: string,
): { readonly tip: string; readonly clean: boolean } {
  return { tip: tipOf(workspace, branchOf(order)), clean: isClean(workspace, "all") };
}

export function alignBranch(workspace: string, order: string, head: string): void {
  const branch = branchOf(order);
  const tip = tipOf(workspace, branch);
  if (tip !== head) moveRef(workspace, branch, head, tip);
}

export type SliceTurn = {
  readonly order: string;
  readonly workspace: string;
  readonly acting: Acting;
  readonly env: Env;
};

export function submitSlice(db: Database, turn: SliceTurn): { readonly committed: string } {
  const { order, workspace, acting } = turn;
  const branch = branchOf(order);
  const tip = tipOf(workspace, branch);
  const submitted = recordWork(db, order, acting, "build", () => ({
    action: "slice_submitted",
    details: { tip },
  }));
  const { head, conflict, commits } = submitted.state;
  invariant(head !== null, `order ${order} has a recorded head once its workspace is made`);
  const refused = (verdict: SliceVerdict, evidence: readonly Evidence[]): never => {
    recordVerdict(db, order, submitted.seq, "build", {
      action: "slice_refused",
      code: verdict.code,
      details: { tip },
      evidence: [...evidence],
    });
    moveRef(workspace, branch, head, tip);
    throw refuseSlice(verdict.code, { order, tip, ...verdict });
  };
  const rebased = conflict === null ? [] : commitsBetween(workspace, conflict.onto, tip);
  const early =
    conflict === null
      ? submittedVerdict({
          head,
          parents: parentsOf(workspace, tip),
          checkChanged: checkChanged(workspace, tip, head),
          clean: isClean(workspace, "all"),
        })
      : rebasedVerdict({
          onto: conflict.onto,
          expected: commits.length,
          rebasing: workspaceRebasing({ dir: workspace, branch }),
          onOnto: isAncestor(workspace, conflict.onto, tip),
          commits: rebased.length,
          checkChanged: checkChanged(workspace, tip, conflict.onto),
          clean: isClean(workspace, "all"),
        });
  if (early !== null) return refused(early, []);
  const task = checkTask(workspace);
  if (task === null) return refused({ code: "no_check" }, []);
  const check = judge(workspace, task.commandLine, turn.env);
  const checked = checkVerdict(check, isClean(workspace, "all"));
  if (checked !== null) return refused(checked, [check]);
  recordVerdict(
    db,
    order,
    submitted.seq,
    "build",
    conflict === null
      ? { action: "slice_committed", details: { commit: tip }, evidence: [check] }
      : {
          action: "branch_rebased",
          details: { head: tip, onto: conflict.onto, commits: [...movedCommits(commits, rebased)] },
          evidence: [check],
        },
  );
  return { committed: tip };
}
