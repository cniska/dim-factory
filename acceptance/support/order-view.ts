import { type DimResult, resultOf } from "./dim-output";
import type { Action, Decider, Next, Station, WorkerRole } from "./vocabulary";

type Actor =
  | { readonly kind: "worker"; readonly worker: string; readonly session: string }
  | { readonly kind: "factory"; readonly version: string; readonly cause: number };

type Shared = { readonly seq: number; readonly at: string; readonly by: Actor };

type Evidence = { readonly kind: "check"; readonly output: string } | { readonly kind: "rebase" };

type Details = Readonly<Record<string, unknown>>;

type Detailed =
  | {
      readonly action: "artifact_approved";
      readonly station: Station;
      readonly reason: string;
      readonly decidedBy: Decider;
    }
  | {
      readonly action: "artifact_returned";
      readonly station: Station;
      readonly reason: string;
      readonly decidedBy: Decider;
    }
  | { readonly action: "order_returned"; readonly station: Station; readonly reason: string }
  | { readonly action: "order_cancelled"; readonly reason: string }
  | { readonly action: "message_sent"; readonly details: { readonly to: string } }
  | { readonly action: "session_died"; readonly code: string; readonly details: { readonly session: string } }
  | { readonly action: "station_failed"; readonly code: string; readonly details: Details }
  | { readonly action: "ship_stopped"; readonly code: string; readonly details: Details }
  | {
      readonly action: "slice_refused";
      readonly code: string;
      readonly details: Details;
      readonly evidence: readonly Evidence[];
    }
  | {
      readonly action: "slice_committed";
      readonly details: { readonly commit: string };
      readonly evidence: readonly Evidence[];
    }
  | { readonly action: "ship_landed"; readonly details: Details; readonly evidence: readonly Evidence[] };

type PlainAction = Exclude<Action, Detailed["action"]>;

type Plain = { readonly [A in PlainAction]: { readonly action: A } }[PlainAction];

export type LogEntry = Shared & (Detailed | Plain);

type EntryOf<A extends Action> = Extract<LogEntry, { readonly action: A }>;

type Stop = Extract<LogEntry, { readonly code: string }>;

type SessionView = {
  readonly id: string;
  readonly harness: string;
  readonly pid: number;
  readonly died?: { readonly code: string };
};

type WorkerView = {
  readonly name: string;
  readonly role: WorkerRole;
  readonly createdBy?: string;
  readonly sessions: readonly SessionView[];
};

type FindingView = {
  readonly id: string;
  readonly area: string;
  readonly file: string;
  readonly line: number;
  readonly answer?: "fixed" | "refused";
};

export type OrderView = {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly description: string;
  readonly status: "queued" | "running" | "shipped" | "cancelled";
  readonly station: Station | null;
  readonly next: Next | null;
  readonly branch: string;
  readonly workspace: string;
  readonly log: readonly LogEntry[];
  readonly workers: readonly WorkerView[];
  readonly slices: readonly { readonly title: string; readonly outcome: string; readonly commit?: string }[];
  readonly findings: readonly FindingView[];
};

export function orderShown(result: DimResult): OrderView {
  return resultOf(result) as OrderView;
}

export function workerOf(order: OrderView, role: WorkerRole): WorkerView {
  const found = order.workers.find((worker) => worker.role === role);
  if (!found) throw new Error(`order ${order.id} has no ${role}`);
  return found;
}

export function sessionOf(worker: WorkerView, n: number): SessionView {
  const found = worker.sessions[n];
  if (!found) throw new Error(`${worker.name} has no session ${n + 1}`);
  return found;
}

export function entriesOf<A extends Action>(order: OrderView, action: A): readonly EntryOf<A>[] {
  return order.log.filter((entry): entry is EntryOf<A> => entry.action === action);
}

export function entryOf<A extends Action>(order: OrderView, action: A): EntryOf<A> {
  const [found] = entriesOf(order, action);
  if (!found) throw new Error(`order ${order.id}'s log holds no ${action}`);
  return found;
}

export function causeOf(order: OrderView, entry: LogEntry): LogEntry {
  if (entry.by.kind !== "factory") throw new Error(`${entry.action} was not the factory's`);
  const { cause } = entry.by;
  const found = order.log.find((candidate) => candidate.seq === cause);
  if (!found) throw new Error(`${entry.action} names cause ${cause}, which the log does not hold`);
  return found;
}

export function finalStop(order: OrderView): Stop {
  const last = order.log.at(-1);
  if (last === undefined || !("code" in last))
    throw new Error(`order ${order.id}'s log does not end in a stop`);
  return last;
}

export function actions(order: OrderView): readonly Action[] {
  return order.log.map((entry) => entry.action);
}
