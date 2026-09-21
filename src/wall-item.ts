import type { WallItemEntry, WallItemKind } from "./factory-wall";

/** What each moment in an order's record is called on the item view. Human words lead; the ids
 *  they stand for are on the entry for an agent to join on. */
export const ITEM_KIND_LABELS: Record<WallItemKind, string> = {
  queued: "Queued",
  claimed: "Claimed",
  moved: "Moved",
  plan_submitted: "Plan submitted",
  plan_approved: "Plan approved",
  commit_created: "Commit",
  check_finished: "Check",
  review_opened: "Review opened",
  review_closed: "Review closed",
  finding_raised: "Finding raised",
  finding_answered: "Finding answered",
  document_updated: "Document",
  environment_reported: "Worker environment",
  completed: "Completed",
  dropped: "Dropped",
  failed: "Failed",
};

/** As much of a sha as a person compares, with the whole of it still on the entry. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function findingKey(entry: Pick<WallItemEntry, "finding">): string | null {
  if (!entry.finding) return null;
  return `${entry.finding.dimension}\u0000${entry.finding.summary}`;
}
