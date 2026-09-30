export const ACTION = {
  added: "order_added",
  run: "order_run",
  revised: "order_revised",
  cancelled: "order_cancelled",
  approved: "artifact_approved",
  returned: "artifact_returned",
  stationStarted: "station_started",
  stationFailed: "station_failed",
  planReturned: "plan_returned",
  sliceCommitted: "slice_committed",
  sliceRefused: "slice_refused",
  findingAnswered: "finding_answered",
  buildReturned: "build_returned",
  reviewReturned: "review_returned",
  findingsReturned: "findings_returned",
  sentBack: "order_sent_back",
  returnRefused: "return_refused",
  messageSent: "message_sent",
  messageRefused: "message_refused",
  sessionDied: "session_died",
  sessionStarted: "session_started",
  shipStarted: "ship_started",
  shipLanded: "ship_landed",
  shipStopped: "ship_stopped",
  cleanedUp: "cleaned_up",
} as const;

export const NEXT = {
  run: "run",
  approve: "approve",
  revise: "revise",
  decide: "decide",
} as const;

export const REFUSAL = {
  notNext: "not_next_step",
  busy: "order_busy",
  notOperator: "not_operator",
  noSession: "no_session",
  usage: "usage",
} as const;
