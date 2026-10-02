import { invariant, unreachable } from "./assert";
import type { CodedError } from "./coded-error";
import {
  type ActKind,
  type Answer,
  CROCKFORD,
  type DeathCode,
  type Decider,
  type Later,
  type LaterEntry,
  type Next,
  type OperatorAct,
  ORDER_ID_LENGTH,
  type OrderAdded,
  type Plan,
  type RecordedFinding,
  type RunKind,
  refuseOrder,
  type Station,
  type Status,
} from "./order-contract";
import { type Acting, refuseWorker, type StationRole } from "./worker-contract";

export function orderIdOf(random: Uint8Array): string {
  invariant(random.length === ORDER_ID_LENGTH, `an order id takes ${ORDER_ID_LENGTH} random bytes`);
  return [...random].map((byte) => CROCKFORD[byte % CROCKFORD.length]).join("");
}

type Phase =
  | { readonly kind: "run"; readonly station: Station }
  | { readonly kind: "approve"; readonly station: Station }
  | { readonly kind: "update" }
  | { readonly kind: "ship" }
  | { readonly kind: "done"; readonly station: Station | null };

type RecordedPlan = Plan & { readonly base: number };

type FindingState = RecordedFinding & {
  readonly answered: { readonly answer: Answer; readonly reason: string } | null;
};

export function movedCommits(
  from: readonly string[],
  to: readonly string[],
): readonly { readonly from: string; readonly to: string }[] {
  invariant(from.length === to.length, `a rebase keeps each of the order's ${from.length} commits`);
  return from.map((commit, index) => {
    const moved = to[index];
    invariant(moved !== undefined, `a rebase moves the order's commit ${commit}`);
    return { from: commit, to: moved };
  });
}

export type Conflict = { readonly onto: string; readonly paths: readonly string[] };

type FailedCheck = { readonly command: string; readonly exitCode: number | null; readonly output: string };

type Returned =
  | { readonly kind: "decision"; readonly decidedBy: Decider; readonly reason: string }
  | { readonly kind: "worker"; readonly station: Station; readonly reason: string }
  | { readonly kind: "ship"; readonly check: FailedCheck };

export type Death = { readonly session: string; readonly code: DeathCode; readonly copied: boolean };

export type SliceView = { readonly title: string; readonly outcome: string; readonly commit: string | null };

export type OrderState = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly project: string;
  readonly status: Status;
  readonly phase: Phase;
  readonly planApproved: boolean;
  readonly plan: RecordedPlan | null;
  readonly commits: readonly string[];
  readonly head: string | null;
  readonly findings: readonly FindingState[];
  readonly returned: Returned | null;
  readonly buildArtifact: string | null;
  readonly conflict: Conflict | null;
  readonly died: readonly Death[];
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

export function slicesOf(state: OrderState): readonly SliceView[] {
  if (state.plan === null) return [];
  const { base, slices } = state.plan;
  return slices.map((slice, index) => ({ ...slice, commit: state.commits[base + index] ?? null }));
}

export function openFindings(state: OrderState): readonly FindingState[] {
  return state.findings.filter((finding) => finding.answered === null);
}

export function stationOf(state: OrderState): Station | null {
  return state.status === "queued" ? null : phaseStation(state.phase);
}

function phaseStation(phase: Phase): Station | null {
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

function answered(
  findings: readonly FindingState[],
  id: string,
  answer: Answer,
  reason: string,
): readonly FindingState[] {
  return findings.map((finding) =>
    finding.id === id ? { ...finding, answered: { answer, reason } } : finding,
  );
}

function apply(state: OrderState, entry: Later): OrderState {
  switch (entry.action) {
    case "order_updated":
      return {
        ...state,
        phase: run("plan"),
        title: entry.details.title,
        description: entry.details.description,
        returned: null,
      };
    case "order_run":
      return { ...state, status: "running" };
    case "workspace_created":
      return { ...state, head: entry.details.base };
    case "order_cancelled":
      return { ...state, status: "cancelled", phase: { kind: "done", station: stationOf(state) } };
    case "artifact_approved":
      return approved(state, entry.details.station);
    case "artifact_returned":
      return {
        ...state,
        phase: run(entry.details.station),
        returned: { kind: "decision", decidedBy: entry.details.decidedBy, reason: entry.details.reason },
      };
    case "order_returned":
      return {
        ...returnedByWorker(state, entry.details.station),
        returned: { kind: "worker", station: entry.details.station, reason: entry.details.reason },
      };
    case "plan_returned":
      return {
        ...state,
        returned: null,
        phase: { kind: "approve", station: "plan" },
        plan: { body: entry.details.body, slices: entry.details.slices, base: state.commits.length },
      };
    case "slice_committed":
      return {
        ...state,
        commits: [...state.commits, entry.details.commit],
        head: entry.details.commit,
        conflict: null,
      };
    case "finding_answered":
      return {
        ...state,
        findings: answered(state.findings, entry.details.finding, entry.details.answer, entry.details.reason),
      };
    case "build_returned":
      return {
        ...state,
        returned: null,
        buildArtifact: entry.details.artifact,
        phase: { kind: "approve", station: "build" },
      };
    case "review_returned": {
      const { returned } = entry.details;
      if (returned.kind === "artifact") {
        return { ...state, returned: null, phase: { kind: "approve", station: "review" } };
      }
      return {
        ...state,
        returned: null,
        phase: run("build"),
        findings: returned.findings.map((finding) => ({ ...finding, answered: null })),
      };
    }
    case "branch_rebased": {
      const moved = new Map(entry.details.commits.map(({ from, to }) => [from, to]));
      return {
        ...state,
        head: entry.details.head,
        conflict: null,
        commits: state.commits.map((commit) => {
          const to = moved.get(commit);
          invariant(to !== undefined, `a rebase of order ${state.id} moves its commit ${commit}`);
          return to;
        }),
      };
    }
    case "ship_stopped":
      switch (entry.code) {
        case "ship_conflict":
          return {
            ...state,
            phase: run("build"),
            conflict: { onto: entry.details.onto, paths: entry.details.paths },
          };
        case "ship_check_failed": {
          const [{ command, exitCode, output }] = entry.evidence;
          return {
            ...state,
            phase: run("build"),
            returned: { kind: "ship", check: { command, exitCode, output } },
          };
        }
        case "ship_unset":
        case "ship_no_check":
        case "checkout_dirty":
        case "rebase_failed":
          return { ...state, phase: { kind: "ship" } };
        default:
          return unreachable(entry);
      }
    case "ship_landed":
      return {
        ...state,
        status: "shipped",
        phase: { kind: "done", station: "review" },
        head: entry.details.head,
      };
    case "session_died":
      return {
        ...state,
        died: [
          ...state.died,
          { session: entry.details.session, code: entry.code, copied: entry.details.copied },
        ],
      };
    case "slice_submitted":
    case "slice_refused":
    case "message_sent":
    case "message_refused":
    case "session_started":
    case "station_failed":
    case "ship_started":
      return state;
    default:
      return unreachable(entry);
  }
}

export function operatorEntry(state: OrderState, act: OperatorAct): Later {
  switch (act.kind) {
    case "run":
      return { action: "order_run", details: {} };
    case "approve":
    case "return": {
      const { phase } = state;
      invariant(phase.kind === "approve", `order ${state.id} is admitted to ${act.kind} only at approval`);
      const details = {
        station: phase.station,
        reason: act.decision.reason,
        decidedBy: act.decision.decidedBy,
      };
      return act.kind === "approve"
        ? { action: "artifact_approved", details }
        : { action: "artifact_returned", details };
    }
    case "update":
      return {
        action: "order_updated",
        details: { title: act.title ?? state.title, description: act.description ?? state.description },
      };
    case "cancel":
      return { action: "order_cancelled", details: { reason: act.reason } };
    case "message":
      return { action: "message_sent", details: { to: act.to, text: act.text } };
    default:
      return unreachable(act);
  }
}

export function phaseAfter(state: OrderState, act: OperatorAct): Phase | null {
  return stepRefusal(state, act.kind) === null ? apply(state, operatorEntry(state, act)).phase : null;
}

export function runKindOf(phase: Phase): RunKind {
  return phase.kind === "ship" ? "ship" : "station";
}

type AddedEntry = OrderAdded & { readonly seq: number };

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
    returned: null,
    buildArtifact: null,
    conflict: null,
    died: [],
    lastSeq: added.seq,
  };
  return later.reduce((state, entry) => ({ ...apply(state, entry), lastSeq: entry.seq }), start);
}

export function operatorRefusal(by: Acting, project: string): CodedError | null {
  return by.worker.role === "operator" && by.worker.project === project
    ? null
    : refuseWorker("not_operator", { project });
}

const STEPS: Readonly<Record<Next, readonly ActKind[]>> = {
  run: ["run"],
  approve: ["approve", "return"],
  update: [],
};

export function admits(state: OrderState): readonly ActKind[] {
  const next = nextOf(state.phase);
  if (next === null) return [];
  return [...STEPS[next], ...(state.planApproved ? [] : ["update" as const]), "cancel", "message"];
}

export function stepRefusal(state: OrderState, act: ActKind): CodedError | null {
  const admitted = admits(state);
  return admitted.includes(act)
    ? null
    : refuseOrder("not_admitted", { order: state.id, act, admits: admitted, next: nextOf(state.phase) });
}

function busyRefusal(state: OrderState, act: ActKind, live: RunKind | null): CodedError | null {
  if (live === null || (act === "cancel" && live === "station")) return null;
  return refuseOrder("order_busy", { order: state.id, run: live });
}

export const ROLE_AT: Readonly<Record<Station, StationRole>> = {
  plan: "planner",
  build: "builder",
  review: "reviewer",
};

export function atStation(state: OrderState, station: Station): boolean {
  const { phase } = state;
  return state.status === "running" && phase.kind === "run" && phase.station === station;
}

export type WorkBy =
  | { readonly kind: "worker"; readonly acting: Acting }
  | { readonly kind: "factory"; readonly cause: number };

export function workRefusal(state: OrderState, station: Station, by: WorkBy): CodedError | null {
  if (by.kind === "worker") {
    const { worker } = by.acting;
    if (worker.role !== ROLE_AT[station] || worker.order !== state.id) {
      return refuseWorker("not_station_worker", { order: state.id, station });
    }
  }
  return atStation(state, station) ? null : refuseOrder("not_at_station", { order: state.id, station });
}

export function operatorActRefusal(
  state: OrderState,
  by: Acting,
  act: ActKind,
  live: RunKind | null,
): CodedError | null {
  return operatorRefusal(by, state.project) ?? busyRefusal(state, act, live) ?? stepRefusal(state, act);
}
