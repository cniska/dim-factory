export const ORDER_EVENT_KINDS = [
  "queued",
  "claimed",
  "moved",
  "provenance_recorded",
  "priority_changed",
  "hold_set",
  "hold_released",
  "plan_artifact_written",
  "plan_approved",
  "artifact_returned",
  "build_approved",
  "build_artifact_written",
  "commit_created",
  "commit_rewritten",
  "check_finished",
  "review_opened",
  "review_closed",
  "review_artifact_written",
  "review_approved",
  "finding_raised",
  "finding_answered",
  "integration_recorded",
  "delivery_recorded",
  "owner_verdict_recorded",
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

export type OrderAttempt = {
  orderId: string;
  runId: string;
  worker?: string;
  operatorWorker?: string;
  sessionId?: string;
  providerSessionId?: string;
  station?: string;
  harness?: string;
  model?: string;
  tier?: string;
  startedAt: string;
  endedAt?: string;
  outcome: AttemptOutcome;
  reason?: string;
};

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

export type OrderVerdict = {
  orderId: string;
  decision: "approved" | "returned" | "held" | "dropped";
  grounds: string;
  worker: string;
  sessionId?: string;
  recordedAt: string;
};

export type OrderDelivery = {
  orderId: string;
  kind: "integration" | "delivery";
  outcome: "succeeded" | "failed";
  target?: string;
  commitSha?: string;
  worker?: string;
  sessionId?: string;
  recordedAt: string;
  reason?: string;
};
