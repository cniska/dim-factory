import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { declaredCheck, judge } from "./check-ops";
import type { CodedError } from "./coded-error";
import type { Evidence } from "./order-contract";
import { orderState, recordVerdict, recordWork } from "./order-ops";
import { checkVerdict, submittedVerdict } from "./slice";
import { refuseSlice, type SliceCode } from "./slice-contract";
import { branchTip, checkChanged, isClean, moveBranch, parentsOf } from "./slice-effects";
import type { Acting } from "./worker-contract";
import { branchOf } from "./workspace";
import { publishRecordedHead } from "./workspace-ops";

export function branchFacts(
  workspace: string,
  order: string,
): { readonly tip: string; readonly clean: boolean } {
  return { tip: branchTip(workspace, branchOf(order)), clean: isClean(workspace) };
}

export function alignBranch(workspace: string, order: string, head: string): void {
  const branch = branchOf(order);
  const tip = branchTip(workspace, branch);
  if (tip !== head) moveBranch(workspace, branch, head, tip);
}

export type SliceTurn = {
  readonly order: string;
  readonly project: string;
  readonly workspace: string;
  readonly checkout: string;
  readonly acting: Acting;
};

export function submitSlice(db: Database, turn: SliceTurn): { readonly committed: string } {
  const { order, workspace, acting } = turn;
  const branch = branchOf(order);
  const command = declaredCheck(workspace);
  if (command === null) throw refuseSlice("no_check", { order });
  const tip = branchTip(workspace, branch);
  const cause = recordWork(db, order, acting, "build", () => ({
    action: "slice_submitted",
    details: { tip },
  }));
  const { head } = orderState(db, order);
  invariant(head !== null, `order ${order} has a recorded head once its workspace is made`);
  const refused = (code: SliceCode, evidence: readonly Evidence[], refusal: CodedError): never => {
    recordVerdict(db, order, cause, "build", {
      action: "slice_refused",
      code,
      details: { tip },
      evidence: [...evidence],
    });
    moveBranch(workspace, branch, head, tip);
    throw refusal;
  };
  const submitted = submittedVerdict({
    head,
    parents: parentsOf(workspace, tip),
    checkChanged: checkChanged(workspace, tip, head),
    clean: isClean(workspace),
  });
  if (submitted === "head_moved") refused(submitted, [], refuseSlice("head_moved", { order, tip, head }));
  if (submitted !== null) refused(submitted, [], refuseSlice(submitted, { order, tip }));
  const check = judge(workspace, command);
  const checked = checkVerdict(check.exitCode, isClean(workspace));
  if (checked === "check_failed") {
    refused(checked, [check], refuseSlice(checked, { order, tip, command, exitCode: check.exitCode }));
  }
  if (checked === "check_rewrote") refused(checked, [check], refuseSlice(checked, { order, tip, command }));
  recordVerdict(db, order, cause, "build", {
    action: "slice_committed",
    details: { commit: tip },
    evidence: [check],
  });
  publishRecordedHead(turn.checkout, turn.project, order, tip);
  return { committed: tip };
}
