import type { StopOf } from "./order-contract";

export type SubmittedFacts = {
  readonly tip: string;
  readonly head: string;
  readonly parents: readonly string[];
  readonly checkChanged: boolean;
};

export function submittedVerdict({
  tip,
  head,
  parents,
  checkChanged,
}: SubmittedFacts): StopOf<"slice_refused"> | null {
  if (parents.length !== 1 || parents[0] !== head)
    return { action: "slice_refused", code: "head_moved", details: { tip, head } };
  return changed(tip, checkChanged);
}

export type RebasedFacts = {
  readonly tip: string;
  readonly onto: string;
  readonly expected: number;
  readonly rebasing: boolean;
  readonly onOnto: boolean;
  readonly commits: number;
  readonly checkChanged: boolean;
};

export function rebasedVerdict(facts: RebasedFacts): StopOf<"slice_refused"> | null {
  const { tip, onto, expected } = facts;
  if (facts.rebasing || !facts.onOnto || facts.commits !== expected)
    return { action: "slice_refused", code: "not_rebased", details: { tip, onto, commits: expected } };
  return changed(tip, facts.checkChanged);
}

function changed(tip: string, checkChanged: boolean): StopOf<"slice_refused"> | null {
  return checkChanged ? { action: "slice_refused", code: "check_changed", details: { tip } } : null;
}
