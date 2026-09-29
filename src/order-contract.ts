import type { SandboxedCheck } from "./check-sandbox";
import { CodedError } from "./coded-error";
import type { Replay, Rewrite } from "./git-rebase-contract";
import type { OrderStatus } from "./order-status";
import type { Station } from "./station-contract";

export type ShipRun = { rebased?: { rewrite: Rewrite; check: SandboxedCheck } } & (
  | { outcome: "landed" }
  | { outcome: "refused"; code: string; reason: string }
  | { outcome: "conflict"; replay: Omit<Replay, "worktree">; paths: readonly string[]; stoppedAt: string }
);

export type OrderArtifact = {
  id: number;
  kind: Station;
  revision: number;
  headSha: string | null;
  reviewId: number | null;
  approved: boolean;
  returned: boolean;
};

export type OrderSliceRecord = { id: number; artifactId: number; ordinal: number; done: boolean };

export type OrderCommitRecord = { id: number; sha: string; retires: string | null; shipRunId: number | null };

export type OrderShipRunRecord = {
  id: number;
  outcome: string;
  oldHead: string | null;
  patchEqual: number | null;
};

export type OrderCheckRecord = { id: number; headSha: string | null; exitCode: number };

export type OrderReviewRecord = { id: number; headSha: string };

export type OrderFindingRecord = { id: number; reviewId: number; answered: boolean };

type Written = { ts?: string };

export type OrderEvent = Written &
  (
    | { kind: "queued"; worker: string }
    | { kind: "started"; worker: string }
    | { kind: "dropped"; worker: string; reason: string }
    | { kind: "station_started"; worker: string; station: Station; sessionId?: string }
    | { kind: "artifact_submitted"; worker: string; artifactId: number }
    | { kind: "artifact_approved"; worker: string; artifactId: number; reason?: string }
    | { kind: "artifact_returned"; worker: string; station: Station; artifactId: number; reason: string }
    | { kind: "commit_created"; worker: string; commitSha: string }
    | { kind: "finding_raised"; worker: string; findingId: number }
    | { kind: "finding_answered"; worker: string; findingId: number; answerId: number }
    | { kind: "ship_retried"; worker: string }
    | { kind: "failed"; worker?: string; station: Station; reason: string }
  );

export type OrderEventColumns = {
  worker?: string;
  sessionId?: string;
  station?: Station;
  commitSha?: string;
  findingId?: number;
  answerId?: number;
  artifactId?: number;
  reason?: string;
};

export type Order = {
  id: string;
  status: OrderStatus;
  artifacts: OrderArtifact[];
  slices: OrderSliceRecord[];
  commits: OrderCommitRecord[];
  shipRuns: OrderShipRunRecord[];
  checks: OrderCheckRecord[];
  reviews: OrderReviewRecord[];
  findings: OrderFindingRecord[];
};

type Waiting = { orderId: string; station: Station | null; next: "run" | "approve" | "ship" };

const waitsOn = (w: Waiting): string => (w.station === null ? w.next : `${w.next} at ${w.station}`);

function command(w: Waiting): string {
  if (w.next === "run") return `dim order ${w.station} ${w.orderId}`;
  if (w.next === "approve" && w.station === "build") return `dim order approve ${w.orderId} --reason "..."`;
  return `dim order ${w.next} ${w.orderId}`;
}

const MESSAGES = {
  order_unknown: (m: { orderId: string }) =>
    `no order ${m.orderId} is recorded; \`dim q factory\` lists the orders`,
  not_next: (m: Waiting & { act: string }) =>
    `order ${m.orderId} waits on ${waitsOn(m)}, so it cannot ${m.act}; its next act is \`${command(m)}\``,
  order_terminal: (m: { orderId: string; status: string; act: string }) =>
    `order ${m.orderId} is ${m.status}, so it cannot ${m.act}; nothing more runs on a ${m.status} order`,
  order_not_running: (m: { orderId: string; status: OrderStatus }) =>
    m.status === "queued"
      ? `order ${m.orderId} is not started; \`dim order plan ${m.orderId}\` starts it`
      : `order ${m.orderId} is already ${m.status}; nothing more runs on a ${m.status} order`,
  order_not_queued: (m: { orderId: string; status: string; act: string }) =>
    `order ${m.orderId} is ${m.status} and only a queued order can be ${m.act}; \`dim q order ${m.orderId}\` shows its next act`,
  order_held_by_run: (m: { orderId: string; worker: string; runId: string; act: string }) =>
    `order ${m.orderId} is being worked by ${m.worker} under ${m.runId}, so it cannot ${m.act}; wait for that run to finish, which \`dim q order ${m.orderId}\` shows`,
  rebase_conflict_pending: (m: { orderId: string; act: string }) =>
    `order ${m.orderId} has a rebase conflict the builder must resolve, so it cannot ${m.act}; \`dim order build ${m.orderId}\` resolves it first`,
  order_not_checked: (m: { orderId: string }) =>
    `order ${m.orderId} has no check that passed at its last commit; the build turn that commits runs the check`,
  no_final_build_turn: (m: { orderId: string }) =>
    `order ${m.orderId} has no active final build turn; a Build artifact is recorded on the turn that finishes the last slice`,
  build_artifact_before_final_slice: (m: { orderId: string }) =>
    `order ${m.orderId} must finish its final slice before recording a Build artifact; a Build artifact is recorded on the turn that finishes the last slice`,
};

export type OrderErrorCode = keyof typeof MESSAGES;
export type OrderErrorMeta<Code extends OrderErrorCode> = Parameters<(typeof MESSAGES)[Code]>[0];

export function fail<Code extends OrderErrorCode>(
  code: Code,
  meta: OrderErrorMeta<Code>,
): CodedError<Code, OrderErrorMeta<Code>> {
  const message = (MESSAGES[code] as (m: OrderErrorMeta<Code>) => string)(meta);
  return new CodedError(code, message, meta);
}
