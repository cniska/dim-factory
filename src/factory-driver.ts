import type { Database } from "bun:sqlite";
import {
  appendOrderEvent,
  createOrder,
  isTerminalOrderStatus,
  type Order,
  type OrderEvent,
  type OrderFile,
  type OrderStatus,
  orderStatus,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderEnvironment,
  recordOrderFile,
  recordOrderFinding,
  updateOrderLocation,
} from "./factory-order";
import type { WorkerHookReport } from "./worker-environment";

export type FactoryOutcome = {
  status: Exclude<OrderStatus, "claimed" | "working">;
  reason?: string;
};

export type FactoryContext = {
  item: Order;
  baseRevision: string;
  setLocation(worktree: string, branch: string): void;
  appendEvent(event: OrderEvent): void;
  delegate(agentId: string, sessionId?: string, station?: string): void;
  stop(outcome: FactoryOutcome): void;
  recordCommit(sha: string, subject?: string): void;
  recordFile(file: OrderFile): void;
  recordCheck(check: {
    command: string;
    exitCode: number;
    startedAt?: string;
    finishedAt?: string;
    result?: string;
  }): number;
  recordFinding(finding: {
    dimension: string;
    summary: string;
    answer: "fixed" | "refused";
    resolution?: string;
  }): number;
  recordDocument(path: string): void;
  recordEnvironment(report: WorkerHookReport): void;
};

export type FactoryBuilder = (context: FactoryContext) => FactoryOutcome | Promise<FactoryOutcome>;

export async function runFactoryOrder(
  db: Database,
  item: Order,
  options: { baseRevision: string },
  build: FactoryBuilder,
): Promise<FactoryOutcome> {
  createOrder(db, item);
  appendOrderEvent(db, item.id, { kind: "started", status: "working" });

  const context: FactoryContext = {
    item,
    baseRevision: options.baseRevision,
    setLocation: (worktree, branch) => updateOrderLocation(db, item.id, worktree, branch),
    appendEvent: (event) => appendOrderEvent(db, item.id, event),
    delegate: (agentId, sessionId, station) =>
      appendOrderEvent(db, item.id, {
        kind: "delegated",
        delegatedAgentId: agentId,
        delegatedSessionId: sessionId,
        delegatedStation: station,
      }),
    stop: (outcome) =>
      appendOrderEvent(db, item.id, { kind: outcome.status, status: outcome.status, reason: outcome.reason }),
    recordCommit: (sha, subject) => recordOrderCommit(db, item.id, sha, subject),
    recordFile: (file) => recordOrderFile(db, item.id, file),
    recordCheck: (check) => recordOrderCheck(db, item.id, check),
    recordFinding: (finding) => recordOrderFinding(db, item.id, finding),
    recordDocument: (path) => recordOrderDocument(db, item.id, path),
    recordEnvironment: (report) => recordOrderEnvironment(db, item.id, report),
  };

  try {
    const outcome = await build(context);
    const status = orderStatus(db, item.id);
    if (!isTerminalOrderStatus(status)) {
      appendOrderEvent(db, item.id, { kind: outcome.status, status: outcome.status, reason: outcome.reason });
    } else if (status !== outcome.status) {
      throw new Error(`order ${item.id} stopped as ${status} but builder returned ${outcome.status}`);
    }
    return outcome;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!isTerminalOrderStatus(orderStatus(db, item.id))) {
      try {
        appendOrderEvent(db, item.id, { kind: "failed", status: "failed", reason });
      } catch (failureError) {
        throw new AggregateError([error, failureError], reason);
      }
    }
    throw error;
  }
}
