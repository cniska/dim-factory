import type { OrderEventKind } from "../order-events";
import { STATION_LABELS } from "./board";
import type { WallItemEntry } from "./server";

export const ITEM_KIND_LABELS: Record<OrderEventKind, string> = {
  queued: "Queued",
  started: "Order started",
  station_started: "Station started",
  priority_changed: "Priority changed",
  artifact_submitted: "Artifact submitted",
  artifact_approved: "Artifact approved",
  artifact_returned: "Artifact returned",
  commit_created: "Commit",
  commit_rewritten: "Commit rebased",
  finding_raised: "Finding raised",
  finding_answered: "Finding answered",
  ship_retried: "Ship retried",
  ship_failed: "Ship failed",
  shipped: "Shipped",
  dropped: "Dropped",
  failed: "Failed",
};

const STATION_VERBS: Partial<Record<OrderEventKind, string>> = {
  station_started: "started",
  artifact_submitted: "submitted",
  artifact_approved: "approved",
  artifact_returned: "returned",
};

export function itemKindLabel(entry: Pick<WallItemEntry, "kind" | "station">): string {
  if (entry.kind === "failed" && entry.station) return `${STATION_LABELS[entry.station]} failed`;
  const verb = STATION_VERBS[entry.kind];
  if (verb === undefined) return ITEM_KIND_LABELS[entry.kind];
  if (!entry.station) throw new Error(`${entry.kind} names no station`);
  return `${STATION_LABELS[entry.station]} ${verb}`;
}
