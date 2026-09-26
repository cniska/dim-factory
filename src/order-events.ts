export const ORDER_EVENT_KINDS = [
  "queued",
  "claimed",
  "moved",
  "provenance_recorded",
  "priority_changed",
  "hold_set",
  "hold_released",
  "artifact_written",
  "artifact_approved",
  "artifact_returned",
  "commit_created",
  "commit_rewritten",
  "check_finished",
  "review_opened",
  "review_closed",
  "finding_raised",
  "finding_answered",
  "finding_ruled",
  "refusal_decided",
  "integration_recorded",
  "delivery_recorded",
  "completed",
  "dropped",
  "failed",
  "recovered",
] as const;

export type OrderEventKind = (typeof ORDER_EVENT_KINDS)[number];
export const ORDER_EVENT_KINDS_SQL = ORDER_EVENT_KINDS.map((kind) => `'${kind}'`).join(",");

export const ATTEMPT_OUTCOMES = [
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "cancelled",
] as const;

export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];
export const ATTEMPT_OUTCOMES_SQL = ATTEMPT_OUTCOMES.map((outcome) => `'${outcome}'`).join(",");

export type EvidenceReference = Record<string, string | number | boolean | null>;

export type ScheduleInvocation = {
  scheduleId: string;
  evaluatedAt: string;
  due: boolean;
  dispatched: boolean;
  selectedOrderIds: readonly string[];
  worker?: string;
  sessionId?: string;
  harness?: string;
  model?: string;
  tier?: string;
  outcome: "not_due" | "dispatched" | "failed";
  reason?: string;
};
