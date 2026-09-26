import type { WallItemEntry, WallItemKind, WallStation } from "./factory-wall";

export const ITEM_KIND_LABELS: Record<WallItemKind, string> = {
  queued: "Queued",
  claimed: "Claimed",
  moved: "Moved",
  provenance_recorded: "Provenance",
  priority_changed: "Priority changed",
  hold_set: "Hold set",
  hold_released: "Hold released",
  artifact_written: "Artifact written",
  artifact_approved: "Artifact approved",
  artifact_returned: "Artifact returned",
  commit_created: "Commit",
  commit_rewritten: "Commit rebased",
  check_finished: "Check",
  review_opened: "Review opened",
  review_closed: "Review closed",
  finding_raised: "Finding raised",
  finding_answered: "Finding answered",
  finding_ruled: "Finding ruled",
  refusal_decided: "Owner ruling",
  integration_recorded: "Integration",
  delivery_recorded: "Delivery",
  document_updated: "Document",
  environment_reported: "Worker environment",
  completed: "Completed",
  dropped: "Dropped",
  failed: "Failed",
  recovered: "Recovered",
};

const ARTIFACT_NAMES: Partial<Record<WallStation, string>> = {
  plan: "Plan",
  build: "Build",
  review: "Review",
};

const ARTIFACT_VERBS: Partial<Record<WallItemKind, string>> = {
  artifact_written: "written",
  artifact_approved: "approved",
  artifact_returned: "returned",
};

export function itemKindLabel(entry: Pick<WallItemEntry, "kind" | "station">): string {
  const verb = ARTIFACT_VERBS[entry.kind];
  if (verb === undefined) return ITEM_KIND_LABELS[entry.kind];
  const name = entry.station && ARTIFACT_NAMES[entry.station];
  if (!name) throw new Error(`${entry.kind} names no artifact station`);
  return `${name} ${verb}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function findingKey(entry: Pick<WallItemEntry, "finding">): string | null {
  if (!entry.finding) return null;
  return `${entry.finding.dimension}\u0000${entry.finding.failure}`;
}
