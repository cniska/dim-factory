export type Actor =
  | { kind: "worker"; worker: string; session: string }
  | { kind: "factory"; version: string; cause: number };

export type LogEntry = {
  seq: number;
  at: string;
  action: string;
  station?: "plan" | "build" | "review";
  by: Actor;
  reason?: string;
  decidedBy?: "owner" | "operator" | string;
  code?: string;
  details?: Record<string, unknown>;
  evidence?: { kind: string; output?: string; [field: string]: unknown }[];
};

export type SessionView = { id: string; harness: string; pid: number; died?: { code: string } };

export type WorkerView = { name: string; role: string; createdBy?: string; sessions: SessionView[] };

export type FindingView = { id: string; area: string; file: string; line: number; answer?: string };

export type OrderView = {
  id: string;
  title: string;
  project: string;
  request: string;
  status: "queued" | "running" | "shipped" | "cancelled";
  station: "plan" | "build" | "review" | null;
  next: string | null;
  branch: string;
  worktree: string;
  log: LogEntry[];
  workers: WorkerView[];
  slices: { title: string; outcome: string; commit?: string }[];
  findings: FindingView[];
};

export function workerOf(order: OrderView, role: string): WorkerView {
  const found = order.workers.find((worker) => worker.role === role);
  if (!found) throw new Error(`order ${order.id} has no ${role}`);
  return found;
}

export function actions(order: OrderView): string[] {
  return order.log.map((entry) => entry.action);
}
