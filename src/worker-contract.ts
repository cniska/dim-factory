import { CodedError } from "./coded-error";

type MapFile = { path: string };

const MESSAGES = {
  worker_missing: (_m: Record<string, never>) =>
    "no live worker owns this process; a session registers one through its hooks, or `dim operator` registers the operator",
  worker_over: (m: { worker: string; endedAt: string | null }) =>
    m.endedAt === null
      ? `worker ${m.worker}'s registered process is gone; a new session registers a new worker`
      : `worker ${m.worker} ended at ${m.endedAt}; a new session registers a new worker`,
  worker_session_taken: (m: { sessionId: string }) => `session ${m.sessionId} already has a factory identity`,
  assignment_missing: (m: { assignmentId: string }) => `no worker assignment ${m.assignmentId} is recorded`,
  assignment_used: (m: { assignmentId: string }) =>
    `assignment ${m.assignmentId} was accepted by another session; a station run issues a new one`,
  routing_unknown_role: (m: { role: string; roles: readonly string[] }) =>
    `${m.role}: no such factory role; the roles are ${m.roles.join(", ")}`,
  routing_no_map: (m: MapFile & { harness: string; template: string; missing: "file" | "harness" }) =>
    m.missing === "harness"
      ? `${m.path}: no map for the ${m.harness} harness; add ${m.template}`
      : `${m.path}: no harness map, so no role resolves to a model; write ${m.template} naming what this harness calls each tier`,
  routing_duplicate_key: (m: MapFile & { keys: readonly string[] }) =>
    `${m.path}: names ${m.keys.join(", ")} twice, so one model silently replaced another`,
  routing_not_object: (m: MapFile & { template: string }) =>
    `${m.path}: the harness map is not an object of ${m.template}`,
  routing_unknown_harness: (m: MapFile & { keys: readonly string[] }) =>
    `${m.path}: names ${m.keys.join(", ")}, which is no supported harness`,
  routing_harness_not_object: (m: MapFile & { harness: string }) =>
    `${m.path}: the ${m.harness} harness map is not an object of tiers`,
  routing_unknown_tier: (m: MapFile & { unknown: readonly string[]; tiers: readonly string[] }) =>
    `${m.path}: names ${m.unknown.join(", ")}, which is no tier; the tiers are ${m.tiers.join(", ")}`,
  routing_tier_unnamed: (m: MapFile & { tier: string }) => `${m.path}: the ${m.tier} tier names no model`,
};

export type WorkerErrorCode = keyof typeof MESSAGES;
type WorkerErrorMeta<Code extends WorkerErrorCode> = Parameters<(typeof MESSAGES)[Code]>[0];

export function fail<Code extends WorkerErrorCode>(
  code: Code,
  meta: WorkerErrorMeta<Code>,
): CodedError<Code, WorkerErrorMeta<Code>> {
  const message = (MESSAGES[code] as (m: WorkerErrorMeta<Code>) => string)(meta);
  return new CodedError(code, message, meta);
}
