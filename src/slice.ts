import type { Evidence, StopOf } from "./order-contract";

export type SubmittedFacts = {
  readonly tip: string;
  readonly head: string;
  readonly parents: readonly string[];
  readonly checkChanged: boolean;
  readonly clean: boolean;
};

export function submittedVerdict({
  tip,
  head,
  parents,
  checkChanged,
  clean,
}: SubmittedFacts): StopOf<"slice_refused"> | null {
  if (parents.length !== 1 || parents[0] !== head)
    return { action: "slice_refused", code: "head_moved", details: { tip, head } };
  return changedOrDirty(tip, checkChanged, clean);
}

export type RebasedFacts = {
  readonly tip: string;
  readonly onto: string;
  readonly expected: number;
  readonly rebasing: boolean;
  readonly onOnto: boolean;
  readonly commits: number;
  readonly checkChanged: boolean;
  readonly clean: boolean;
};

export function rebasedVerdict(facts: RebasedFacts): StopOf<"slice_refused"> | null {
  const { tip, onto, expected } = facts;
  if (facts.rebasing || !facts.onOnto || facts.commits !== expected)
    return { action: "slice_refused", code: "not_rebased", details: { tip, onto, commits: expected } };
  return changedOrDirty(tip, facts.checkChanged, facts.clean);
}

function changedOrDirty(tip: string, checkChanged: boolean, clean: boolean): StopOf<"slice_refused"> | null {
  if (checkChanged) return { action: "slice_refused", code: "check_changed", details: { tip } };
  return clean ? null : { action: "slice_refused", code: "workspace_dirty", details: { tip } };
}

export function checkVerdict(
  tip: string,
  check: Evidence,
  cleanAfter: boolean,
): StopOf<"slice_refused"> | null {
  const { command, exitCode } = check;
  if (exitCode !== 0)
    return {
      action: "slice_refused",
      code: "check_failed",
      details: { tip, command, exitCode },
      evidence: [check],
    };
  if (cleanAfter) return null;
  return { action: "slice_refused", code: "check_rewrote", details: { tip, command }, evidence: [check] };
}
