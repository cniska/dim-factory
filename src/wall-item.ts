import { STATION_LABELS } from "./wall-board";
import type { WallItemEntry, WallItemKind } from "./wall-server";

export const ITEM_KIND_LABELS: Record<WallItemKind, string> = {
  queued: "Queued",
  started: "Started",
  priority_changed: "Priority changed",
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
  ship_failed: "Ship failed",
  shipped: "Shipped",
  document_updated: "Document",
  environment_reported: "Worker environment",
  dropped: "Dropped",
  failed: "Failed",
};

const ARTIFACT_VERBS: Partial<Record<WallItemKind, string>> = {
  artifact_written: "written",
  artifact_approved: "approved",
  artifact_returned: "returned",
};

export function itemKindLabel(entry: Pick<WallItemEntry, "kind" | "station">): string {
  const verb = ARTIFACT_VERBS[entry.kind];
  if (verb === undefined) return ITEM_KIND_LABELS[entry.kind];
  if (!entry.station) throw new Error(`${entry.kind} names no artifact station`);
  return `${STATION_LABELS[entry.station]} ${verb}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function findingKey(entry: Pick<WallItemEntry, "finding">): string | null {
  if (!entry.finding) return null;
  return `${entry.finding.dimension}\u0000${entry.finding.failure}`;
}
