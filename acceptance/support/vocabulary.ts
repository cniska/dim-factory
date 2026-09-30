export const ACTION = {
  added: "order_added",
  run: "order_run",
  cancelled: "order_cancelled",
  approved: "artifact_approved",
  stationFailed: "station_failed",
  planReturned: "plan_returned",
  sliceSubmitted: "slice_submitted",
  sliceCommitted: "slice_committed",
  sliceRefused: "slice_refused",
  findingAnswered: "finding_answered",
  buildReturned: "build_returned",
  reviewReturned: "review_returned",
  orderReturned: "order_returned",
  messageSent: "message_sent",
  messageRefused: "message_refused",
  sessionDied: "session_died",
  sessionStarted: "session_started",
  shipStarted: "ship_started",
  shipLanded: "ship_landed",
  shipStopped: "ship_stopped",
  cleanedUp: "cleaned_up",
} as const;

export type Action = (typeof ACTION)[keyof typeof ACTION];

export const NEXT = {
  run: "run",
  approve: "approve",
  revise: "revise",
  decide: "decide",
} as const;

export type Next = (typeof NEXT)[keyof typeof NEXT];

export const REFUSAL = {
  notNext: "not_next_step",
  busy: "order_busy",
  notOperator: "not_operator",
  noSession: "no_session",
  usage: "usage",
} as const;

export const STATIONS = {
  plan: { role: "planner", skill: "dim-plan" },
  build: { role: "builder", skill: "dim-build" },
  review: { role: "reviewer", skill: "dim-review" },
} as const;

export type Station = keyof typeof STATIONS;

export const STATION_NAMES = Object.keys(STATIONS) as readonly Station[];

export type StationRole = (typeof STATIONS)[Station]["role"];

export const STATION_ROLES: readonly StationRole[] = Object.values(STATIONS).map((station) => station.role);

export const WORKER_ROLES = ["operator", ...STATION_ROLES] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];

export type Decider = "owner" | "operator";

export function roleOfSkill(skill: string): StationRole | null {
  return Object.values(STATIONS).find((station) => station.skill === skill)?.role ?? null;
}
