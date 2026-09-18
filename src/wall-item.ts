import type { WallItemEntry, WallItemKind } from "./factory-wall";

/** What each moment in an order's record is called on the item view. Human words lead; the ids
 *  they stand for are on the entry for an agent to join on. */
export const ITEM_KIND_LABELS: Record<WallItemKind, string> = {
  claimed: "Claimed",
  started: "Started",
  moved: "Moved",
  delegated: "Delegated",
  commit_created: "Commit",
  check_finished: "Check",
  review_finished: "Finding",
  document_updated: "Document",
  environment_reported: "Worker environment",
  fenced: "Fenced",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  abandoned: "Abandoned",
};

/** The rail's whole vocabulary. One shape per kind of moment rather than one per kind of
 *  record, so four review rounds read as four identical marks and the eye counts them instead
 *  of reading them. */
export type RailMark = "moment" | "handover" | "outcome";

/** What each mark is drawn as. A dot for a moment, an arrow where one agent's run ends and
 *  another's begins, a filled square where the order stops. */
export const RAIL_MARK_GLYPH: Record<RailMark, string> = {
  moment: "·",
  handover: "→",
  outcome: "■",
};

const RAIL_MARK_BY_KIND: Record<WallItemKind, RailMark> = {
  claimed: "moment",
  started: "moment",
  // A station move is the order itself crossing to other work, which reads as the
  // same kind of passing-on as a delegation even though no agent changes.
  moved: "handover",
  delegated: "handover",
  commit_created: "moment",
  check_finished: "moment",
  review_finished: "moment",
  document_updated: "moment",
  environment_reported: "moment",
  fenced: "outcome",
  blocked: "outcome",
  completed: "outcome",
  failed: "outcome",
  abandoned: "outcome",
};

export type RailStop = {
  at: string;
  mark: RailMark;
  /** The worker the record names for this moment. A moment recorded against no agent leaves it
   *  empty rather than borrowing the one beside it. */
  worker?: string;
  /** Where one agent's run ends and another's begins, the worker it was handed to. */
  handedTo?: string;
};

export function railStops(entries: WallItemEntry[]): RailStop[] {
  return entries.map((entry) => ({
    at: entry.at,
    mark: RAIL_MARK_BY_KIND[entry.kind],
    ...(entry.worker ? { worker: entry.worker } : {}),
    ...(entry.delegatedTo ? { handedTo: entry.delegatedTo.worker } : {}),
  }));
}

/** As much of a sha as a person compares, with the whole of it still on the entry. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
