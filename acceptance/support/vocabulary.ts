export const ACTION = {
  added: "order_added",
  updated: "order_updated",
  run: "order_run",
  workspaceCreated: "workspace_created",
  cancelled: "order_cancelled",
  approved: "artifact_approved",
  artifactReturned: "artifact_returned",
  stationFailed: "station_failed",
  planReturned: "plan_returned",
  sliceSubmitted: "slice_submitted",
  sliceAccepted: "slice_accepted",
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
  branchRebased: "branch_rebased",
  shipLanded: "ship_landed",
  shipStopped: "ship_stopped",
} as const;

export type Action = (typeof ACTION)[keyof typeof ACTION];

export const NEXT = {
  run: "run",
  approve: "approve",
  update: "update",
} as const;

export type Next = (typeof NEXT)[keyof typeof NEXT];

export const REFUSAL = {
  notAdmitted: "not_admitted",
  busy: "order_busy",
  notOperator: "not_operator",
  noSession: "no_session",
  headMoved: "head_moved",
  usage: "usage",
} as const;

export const STATION_NAMES = ["plan", "build", "review"] as const;

export type Station = (typeof STATION_NAMES)[number];

export const STATIONS = {
  plan: { role: "planner", skill: "dim-plan" },
  build: { role: "builder", skill: "dim-build" },
  review: { role: "reviewer", skill: "dim-review" },
} as const satisfies Record<Station, { readonly role: string; readonly skill: string }>;

export type StationRole = (typeof STATIONS)[Station]["role"];

export const STATION_ROLES: readonly StationRole[] = Object.values(STATIONS).map((station) => station.role);

export const WORKER_ROLES = ["operator", ...STATION_ROLES] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];

export type Decider = "owner" | "operator";

export function roleOfSkill(skill: string): StationRole | null {
  return Object.values(STATIONS).find((station) => station.skill === skill)?.role ?? null;
}
