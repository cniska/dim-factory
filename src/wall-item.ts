import type { WallItemEntry, WallItemKind, WallStation } from "./factory-wall";

export const ITEM_KIND_LABELS: Record<WallItemKind, string> = {
  queued: "Queued",
  claimed: "Claimed",
  moved: "Moved",
  provenance_recorded: "Provenance",
  priority_changed: "Priority changed",
  hold_set: "Hold set",
  hold_released: "Hold released",
  plan_artifact_written: "Plan written",
  plan_approved: "Plan approved",
  artifact_returned: "Artifact returned",
  build_approved: "Build approved",
  build_artifact_written: "Build written",
  commit_created: "Commit",
  commit_rewritten: "Commit rebased",
  check_finished: "Check",
  review_opened: "Review opened",
  review_closed: "Review closed",
  review_artifact_written: "Review written",
  review_approved: "Review approved",
  finding_raised: "Finding raised",
  finding_answered: "Finding answered",
  finding_ruled: "Finding ruled",
  refusal_decided: "Owner ruling",
  integration_recorded: "Integration",
  delivery_recorded: "Delivery",
  owner_verdict_recorded: "Owner verdict",
  document_updated: "Document",
  environment_reported: "Worker environment",
  completed: "Completed",
  dropped: "Dropped",
  failed: "Failed",
  recovered: "Recovered",
};

const RETURN_LABELS: Partial<Record<WallStation, string>> = {
  plan: "Plan returned",
  build: "Build returned",
  review: "Review returned",
};

export function itemKindLabel(entry: Pick<WallItemEntry, "kind" | "station">): string {
  if (entry.kind === "artifact_returned" && entry.station) {
    return RETURN_LABELS[entry.station] ?? ITEM_KIND_LABELS[entry.kind];
  }
  return ITEM_KIND_LABELS[entry.kind];
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function findingKey(entry: Pick<WallItemEntry, "finding">): string | null {
  if (!entry.finding) return null;
  return `${entry.finding.dimension}\u0000${entry.finding.failure}`;
}
