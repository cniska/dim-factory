import { nextOf, type OrderState, stationOf } from "./order";
import type { Answer, LogEntry, Next, Severity, Station, Status } from "./order-contract";
import type { Role, WorkerRecord } from "./worker-contract";
import { branchOf } from "./workspace";

type SessionView = {
  readonly id: string;
  readonly harness: string;
  readonly pid: number;
  readonly died?: { readonly code: string };
};

type WorkerView = {
  readonly name: string;
  readonly role: Role;
  readonly createdBy?: string;
  readonly sessions: readonly SessionView[];
};

type SliceView = { readonly title: string; readonly outcome: string; readonly commit?: string };

type FindingView = {
  readonly id: string;
  readonly area: string;
  readonly file: string;
  readonly line: number;
  readonly failure: string;
  readonly fix: string;
  readonly severity: Severity;
  readonly answer?: Answer;
};

export type OrderView = {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly description: string;
  readonly status: Status;
  readonly station: Station | null;
  readonly next: Next | null;
  readonly branch: string;
  readonly workspace: string;
  readonly log: readonly LogEntry[];
  readonly workers: readonly WorkerView[];
  readonly slices: readonly SliceView[];
  readonly findings: readonly FindingView[];
};

export function workerNamesOf(log: readonly LogEntry[]): readonly string[] {
  const names = log.flatMap((entry) => [
    ...(entry.by.kind === "worker" ? [entry.by.worker] : []),
    ...(entry.action === "message_sent" ? [entry.details.to] : []),
    ...(entry.action === "session_started" ? [entry.details.worker] : []),
  ]);
  return [...new Set(names)];
}

function deaths(log: readonly LogEntry[]): ReadonlyMap<string, string> {
  return new Map(
    log.flatMap((entry) =>
      entry.action === "session_died" ? [[entry.details.session, entry.code] as const] : [],
    ),
  );
}

function workerView({ worker, sessions }: WorkerRecord, died: ReadonlyMap<string, string>): WorkerView {
  const views = sessions.map((session): SessionView => {
    const code = died.get(session.id);
    const view = { id: session.id, harness: session.harness, pid: session.process.pid };
    return code === undefined ? view : { ...view, died: { code } };
  });
  const base = { name: worker.name, role: worker.role, sessions: views };
  return worker.role === "operator" ? base : { ...base, createdBy: worker.createdBy };
}

function sliceViews(state: OrderState): readonly SliceView[] {
  if (state.plan === null) return [];
  const { base, slices } = state.plan;
  return slices.map((slice, index) => {
    const commit = state.commits[base + index];
    return commit === undefined ? { ...slice } : { ...slice, commit };
  });
}

export function orderView(
  state: OrderState,
  log: readonly LogEntry[],
  workers: readonly WorkerRecord[],
  workspace: string,
): OrderView {
  const died = deaths(log);
  return {
    id: state.id,
    title: state.title,
    project: state.project,
    description: state.description,
    status: state.status,
    station: state.status === "queued" ? null : stationOf(state.phase),
    next: nextOf(state.phase),
    branch: branchOf(state.id),
    workspace,
    log,
    workers: workers.map((worker) => workerView(worker, died)),
    slices: sliceViews(state),
    findings: state.findings.map(({ answer, ...finding }) =>
      answer === null ? finding : { ...finding, answer },
    ),
  };
}
