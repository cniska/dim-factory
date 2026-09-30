import { invariant, unreachable } from "./assert";
import type { CodedError } from "./coded-error";
import {
  type Answer,
  CROCKFORD,
  type LaterEntry,
  type Next,
  ORDER_ID_LENGTH,
  type OrderAdded,
  type RecordedFinding,
  refuseOrder,
  type Slice,
  type Station,
  type Status,
} from "./order-contract";
import { type Acting, refuseWorker } from "./worker-contract";

export function orderIdOf(random: Uint8Array): string {
  invariant(random.length === ORDER_ID_LENGTH, `an order id takes ${ORDER_ID_LENGTH} random bytes`);
  return [...random].map((byte) => CROCKFORD[byte % CROCKFORD.length]).join("");
}

export type Phase =
  | { readonly kind: "run"; readonly station: Station }
  | { readonly kind: "approve"; readonly station: Station }
  | { readonly kind: "update" }
  | { readonly kind: "ship" }
  | { readonly kind: "done"; readonly station: Station | null };

export type Plan = { readonly body: string; readonly slices: readonly Slice[]; readonly base: number };

export type FindingState = RecordedFinding & { readonly answer: Answer | null };

export type OrderState = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly project: string;
  readonly status: Status;
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

export function stationOf(phase: Phase): Station | null {
  switch (phase.kind) {
    case "run":
    case "approve":
    case "done":
      return phase.station;
    case "update":
      return "plan";
    case "ship":
      return "review";
    default:
      return unreachable(phase);
  }
}

export function nextOf(phase: Phase): Next | null {
  switch (phase.kind) {
    case "run":
    case "ship":
      return "run";
    case "approve":
      return "approve";
    case "update":
      return "update";
    case "done":
      return null;
    default:
      return unreachable(phase);
  }
}

const run = (station: Station): Phase => ({ kind: "run", station });

function approved(state: OrderState, station: Station): OrderState {
  const after = STATION_AFTER[station];
  if (after === "ship") return { ...state, phase: { kind: "ship" } };
  return { ...state, phase: run(after), planApproved: state.planApproved || station === "plan" };
}

function returnedByWorker(state: OrderState, station: Station): OrderState {
  const before = STATION_BEFORE[station];
  return { ...state, phase: before === null ? { kind: "update" } : run(before) };
}

function answered(findings: readonly FindingState[], id: string, answer: Answer): readonly FindingState[] {
  return findings.map((finding) => (finding.id === id ? { ...finding, answer } : finding));
}

function apply(state: OrderState, entry: LaterEntry): OrderState {
  switch (entry.action) {
    case "order_updated":
      return {
        ...state,
        phase: run("plan"),
        title: entry.details.title,
        description: entry.details.description,
      };
    case "order_run":
      return { ...state, status: "running" };
    case "workspace_created":
      return { ...state, head: entry.details.base };
    case "order_cancelled":
      return { ...state, status: "cancelled", phase: { kind: "done", station: stationOf(state.phase) } };
    case "artifact_approved":
      return approved(state, entry.details.station);
    case "artifact_returned":
      return { ...state, phase: run(entry.details.station) };
    case "order_returned":
      return returnedByWorker(state, entry.details.station);
    case "plan_returned":
      return {
        ...state,
        phase: { kind: "approve", station: "plan" },
        plan: { body: entry.details.body, slices: entry.details.slices, base: state.commits.length },
      };
    case "slice_committed":
      return {
        ...state,
        commits: [...state.commits, entry.details.commit],
        head: entry.details.commit,
      };
    case "finding_answered":
      return {
        ...state,
        findings: answered(state.findings, entry.details.finding, entry.details.answer),
      };
    case "build_returned":
      return { ...state, phase: { kind: "approve", station: "build" } };
    case "review_returned": {
      const { returned } = entry.details;
      if (returned.kind === "artifact") return { ...state, phase: { kind: "approve", station: "review" } };
      return {
        ...state,
        phase: run("build"),
        findings: returned.findings.map((finding) => ({ ...finding, answer: null })),
      };
    }
    case "branch_rebased":
      return { ...state, head: entry.details.head };
    case "ship_stopped":
      return entry.code === "ship_conflict" || entry.code === "ship_check_failed"
        ? { ...state, phase: run("build") }
        : { ...state, phase: { kind: "ship" } };
    case "ship_landed":
      return {
        ...state,
        status: "shipped",
        phase: { kind: "done", station: "review" },
        head: entry.details.head,
      };
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

export type AddedEntry = OrderAdded & { readonly seq: number };

export function fold(id: string, added: AddedEntry, later: readonly LaterEntry[]): OrderState {
  const start: OrderState = {
    id,
    title: added.details.title,
    description: added.details.description,
    project: added.details.project,
    status: "queued",
    phase: run("plan"),
    planApproved: false,
    plan: null,
    commits: [],
    head: null,
    findings: [],
    lastSeq: added.seq,
  };
  return later.reduce((state, entry) => ({ ...apply(state, entry), lastSeq: entry.seq }), start);
}

export type OperatorAct =
  | { readonly kind: "run" }
  | { readonly kind: "approve" }
  | { readonly kind: "return" }
  | { readonly kind: "update" }
  | { readonly kind: "cancel" };

export type Admission = { readonly admitted: Acting } | { readonly refused: CodedError };

export function mayAdd(by: Acting | null, project: string): Admission {
  return by?.worker.role === "operator" && by.worker.project === project
    ? { admitted: by }
    : { refused: refuseWorker("not_operator", { project }) };
}

function stepRefusal(state: OrderState, act: OperatorAct): CodedError | null {
  const next = nextOf(state.phase);
  const notNext = () => refuseOrder("not_next_step", { order: state.id, next });
  switch (act.kind) {
    case "run":
      return next === "run" ? null : notNext();
    case "approve":
    case "return":
      return next === "approve" ? null : notNext();
    case "update":
      if (next === null) return notNext();
      return state.planApproved ? refuseOrder("plan_approved", { order: state.id }) : null;
    case "cancel":
      return next === null ? notNext() : null;
    default:
      return unreachable(act);
  }
}

export function admit(state: OrderState, by: Acting | null, act: OperatorAct): Admission {
  const operator = mayAdd(by, state.project);
  if ("refused" in operator) return operator;
  const refused = stepRefusal(state, act);
  return refused === null ? operator : { refused };
}
