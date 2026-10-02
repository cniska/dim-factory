import { admits, nextOf, type OrderState, slicesOf, stationOf } from "./order";
import type { LogEntry, OrderView, SessionView, WorkerView } from "./order-contract";
import type { WorkerRecord } from "./worker-contract";
import { branchOf } from "./workspace";

export function workerNamesOf(log: readonly LogEntry[]): readonly string[] {
  const names = log.flatMap((entry) => [
    ...(entry.by.kind === "worker" ? [entry.by.worker] : []),
    ...(entry.action === "message_sent" ? [entry.details.to] : []),
    ...(entry.action === "session_started" ? [entry.details.worker] : []),
  ]);
  return [...new Set(names)];
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

export function orderView(
  state: OrderState,
  log: readonly LogEntry[],
  workers: readonly WorkerRecord[],
  workspace: string,
): OrderView {
  const died = new Map(state.died.map(({ session, code }) => [session, code]));
  return {
    id: state.id,
    title: state.title,
    project: state.project,
    description: state.description,
    status: state.status,
    station: stationOf(state),
    next: nextOf(state.phase),
    admits: admits(state),
    branch: branchOf(state.id),
    workspace,
    log,
    workers: workers.map((worker) => workerView(worker, died)),
    slices: slicesOf(state),
    findings: state.findings.map(({ answered, ...finding }) =>
      answered === null ? finding : { ...finding, answer: answered.answer },
    ),
  };
}
