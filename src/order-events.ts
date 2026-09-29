export const ORDER_EVENT_KINDS = [
  "queued",
  "started",
  "station_started",
  "priority_changed",
  "artifact_submitted",
  "artifact_approved",
  "artifact_returned",
  "commit_created",
  "finding_raised",
  "finding_answered",
  "ship_retried",
  "dropped",
  "failed",
] as const;

export type OrderEventKind = (typeof ORDER_EVENT_KINDS)[number];
export const ORDER_EVENT_KINDS_SQL = ORDER_EVENT_KINDS.map((kind) => `'${kind}'`).join(",");

export const ATTEMPT_OUTCOMES = [
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "limited",
  "cancelled",
] as const;

export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];
export const ATTEMPT_OUTCOMES_SQL = ATTEMPT_OUTCOMES.map((outcome) => `'${outcome}'`).join(",");

export type EvidenceReference = Record<string, string | number | boolean | null>;
