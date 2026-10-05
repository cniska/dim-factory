import { invariant } from "../assert";
import type { Action } from "../order-contract";
import { STATION_LABELS } from "./board";
import type { WallItemEntry } from "./wall-contract";

type Decided = "artifact_approved" | "artifact_returned" | "order_returned";

export const ACTION_LABELS: Record<Exclude<Action, Decided>, string> = {
  order_added: "Added",
  order_updated: "Updated",
  order_run: "Run",
  workspace_created: "Workspace created",
  order_cancelled: "Cancelled",
  plan_returned: "Plan submitted",
  slice_submitted: "Slice submitted",
  slice_accepted: "Slice accepted",
  slice_refused: "Slice refused",
  finding_answered: "Finding answered",
  build_returned: "Build submitted",
  review_returned: "Review submitted",
  message_sent: "Message",
  message_refused: "Message refused",
  session_started: "Session started",
  session_died: "Session died",
  station_failed: "Station failed",
  ship_started: "Ship started",
  branch_rebased: "Rebased",
  ship_stopped: "Ship stopped",
  ship_landed: "Shipped",
};

export const DECIDED_LABELS: Record<Decided, string> = {
  artifact_approved: "approved",
  artifact_returned: "returned",
  order_returned: "returned the order",
};

function isDecided(action: Action): action is Decided {
  return Object.hasOwn(DECIDED_LABELS, action);
}

export function itemLabel(entry: Pick<WallItemEntry, "action" | "station">): string {
  const { action } = entry;
  if (!isDecided(action)) return ACTION_LABELS[action];
  invariant(entry.station !== null, `${action} names its station`);
  return `${STATION_LABELS[entry.station]} ${DECIDED_LABELS[action]}`;
}
