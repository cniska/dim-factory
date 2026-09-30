import type { SliceVerdict } from "./slice-contract";

export type SubmittedFacts = {
  readonly head: string;
  readonly parents: readonly string[];
  readonly checkChanged: boolean;
  readonly clean: boolean;
};

export function submittedVerdict(facts: SubmittedFacts): SliceVerdict | null {
  if (facts.parents.length !== 1 || facts.parents[0] !== facts.head)
    return { code: "head_moved", head: facts.head };
  if (facts.checkChanged) return { code: "check_changed" };
  return facts.clean ? null : { code: "workspace_dirty" };
}

export type CheckRun = { readonly command: string; readonly exitCode: number | null };

export function checkVerdict(check: CheckRun, cleanAfter: boolean): SliceVerdict | null {
  if (check.exitCode !== 0) return { code: "check_failed", command: check.command, exitCode: check.exitCode };
  return cleanAfter ? null : { code: "check_rewrote", command: check.command };
}
