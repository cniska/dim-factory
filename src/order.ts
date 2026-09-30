import { invariant, unreachable } from "./assert";
import type {
  Answer,
  Detailed,
  LogEntry,
  Next,
  RecordedFinding,
  Slice,
  Station,
  Status,
} from "./order-contract";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

export const ORDER_ID_LENGTH = 8;

export function orderIdOf(random: Uint8Array): string {
  invariant(random.length === ORDER_ID_LENGTH, `an order id takes ${ORDER_ID_LENGTH} random bytes`);
  return [...random].map((byte) => CROCKFORD[byte % CROCKFORD.length]).join("");
}

export type Phase =
  | { readonly kind: "run"; readonly work: Station | "ship" }
  | { readonly kind: "approve" }
  | { readonly kind: "update" }
  | { readonly kind: "done" };

export type Plan = { readonly body: string; readonly slices: readonly Slice[]; readonly base: number };

export type FindingState = RecordedFinding & { readonly answer: Answer | null };

export type OrderState = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly project: string;
  readonly status: Status;
  readonly station: Station | null;
  readonly phase: Phase;
  readonly planApproved: boolean;
  readonly plan: Plan | null;
  readonly commits: readonly string[];
  readonly head: string | null;
  readonly findings: readonly FindingState[];
  readonly lastSeq: number;
};

const STATION_AFTER: Readonly<Record<Station, Station | "ship">> = {
  plan: "build",
  build: "review",
  review: "ship",
};

const STATION_BEFORE: Readonly<Record<Station, Station | null>> = {
  plan: null,
  build: "plan",
  review: "build",
};

function added(id: string, entry: LogEntry | undefined): OrderState {
  invariant(entry?.action === "order_added", `order ${id}'s log starts with order_added`);
  return {
    id,
    title: entry.title,
    description: entry.description,
    project: entry.project,
    status: "queued",
    station: null,
    phase: { kind: "run", work: "plan" },
    planApproved: false,
    plan: null,
    commits: [],
    head: null,
    findings: [],
    lastSeq: entry.seq,
  };
}

function runAt(state: OrderState, station: Station): OrderState {
  return { ...state, station, phase: { kind: "run", work: station } };
}

function approved(state: OrderState, station: Station): OrderState {
  const after = STATION_AFTER[station];
  if (after === "ship") return { ...state, phase: { kind: "run", work: "ship" } };
  return { ...runAt(state, after), planApproved: state.planApproved || station === "plan" };
}

function returnedByWorker(state: OrderState, station: Station): OrderState {
  const before = STATION_BEFORE[station];
  if (before === null) return { ...state, station, phase: { kind: "update" } };
  return runAt(state, before);
}

function answered(findings: readonly FindingState[], id: string, answer: Answer): readonly FindingState[] {
  return findings.map((finding) => (finding.id === id ? { ...finding, answer } : finding));
}

function apply(state: OrderState, entry: Detailed): OrderState {
  switch (entry.action) {
    case "order_added":
      invariant(false, `order ${state.id} is added once`);
      return state;
    case "order_updated":
      return { ...runAt(state, "plan"), title: entry.title, description: entry.description };
    case "order_run":
      return { ...state, status: "running" };
    case "workspace_created":
      return { ...state, head: entry.details.base };
    case "order_cancelled":
      return { ...state, status: "cancelled", phase: { kind: "done" } };
    case "artifact_approved":
      return approved(state, entry.station);
    case "artifact_returned":
      return runAt(state, entry.station);
    case "order_returned":
      return returnedByWorker(state, entry.station);
    case "plan_returned":
      return {
        ...state,
        station: "plan",
        phase: { kind: "approve" },
        plan: { body: entry.body, slices: entry.slices, base: state.commits.length },
      };
    case "slice_committed":
      return { ...state, commits: [...state.commits, entry.details.commit], head: entry.details.commit };
    case "finding_answered":
      return { ...state, findings: answered(state.findings, entry.finding, entry.answer) };
    case "build_returned":
      return { ...state, station: "build", phase: { kind: "approve" } };
    case "review_returned":
      if (entry.returned.kind === "findings") {
        return {
          ...runAt(state, "build"),
          findings: entry.returned.findings.map((finding) => ({ ...finding, answer: null })),
        };
      }
      return { ...state, station: "review", phase: { kind: "approve" } };
    case "branch_rebased":
      return { ...state, head: entry.details.head };
    case "ship_stopped":
      return entry.code === "ship_conflict" || entry.code === "ship_check_failed"
        ? runAt(state, "build")
        : { ...state, phase: { kind: "run", work: "ship" } };
    case "ship_landed":
      return { ...state, status: "shipped", phase: { kind: "done" }, head: entry.details.head };
    case "slice_submitted":
    case "slice_refused":
    case "message_sent":
    case "message_refused":
    case "session_started":
    case "session_died":
    case "station_failed":
    case "ship_started":
    case "cleaned_up":
      return state;
    default:
      return unreachable(entry);
  }
}

export function fold(id: string, log: readonly LogEntry[]): OrderState {
  const [first, ...rest] = log;
  return rest.reduce((state, entry) => ({ ...apply(state, entry), lastSeq: entry.seq }), added(id, first));
}

export function nextOf(phase: Phase): Next | null {
  switch (phase.kind) {
    case "run":
    case "approve":
    case "update":
      return phase.kind;
    case "done":
      return null;
    default:
      return unreachable(phase);
  }
}

export type OperatorAct = "run" | "approve" | "return" | "update" | "cancel";

export type Refusal =
  | { readonly code: "not_next_step"; readonly meta: { readonly next: Next | null } }
  | { readonly code: "plan_approved"; readonly meta: Record<string, never> };

const STEP_OF: Readonly<Record<Exclude<OperatorAct, "update" | "cancel">, Next>> = {
  run: "run",
  approve: "approve",
  return: "approve",
};

export function admit(state: OrderState, act: OperatorAct): Refusal | null {
  const next = nextOf(state.phase);
  const notNext: Refusal = { code: "not_next_step", meta: { next } };
  switch (act) {
    case "run":
    case "approve":
    case "return":
      return next === STEP_OF[act] ? null : notNext;
    case "update":
      if (next === null) return notNext;
      return state.planApproved ? { code: "plan_approved", meta: {} } : null;
    case "cancel":
      return next === null ? notNext : null;
    default:
      return unreachable(act);
  }
}
