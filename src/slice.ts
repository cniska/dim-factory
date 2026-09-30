export type SubmittedFacts = {
  readonly head: string;
  readonly parents: readonly string[];
  readonly checkChanged: boolean;
  readonly clean: boolean;
};

export type SubmittedRefusal = "head_moved" | "check_changed" | "workspace_dirty";

export type CheckRefusal = "check_failed" | "check_rewrote";

export function submittedVerdict(facts: SubmittedFacts): SubmittedRefusal | null {
  if (facts.parents.length !== 1 || facts.parents[0] !== facts.head) return "head_moved";
  if (facts.checkChanged) return "check_changed";
  return facts.clean ? null : "workspace_dirty";
}

export function checkVerdict(exitCode: number | null, cleanAfter: boolean): CheckRefusal | null {
  if (exitCode !== 0) return "check_failed";
  return cleanAfter ? null : "check_rewrote";
}
