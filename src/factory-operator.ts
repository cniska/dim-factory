import type { Database } from "bun:sqlite";
import {
  appendOrderEvent,
  claimOrder,
  isTerminalOrderStatus,
  type OrderClaim,
  type OrderEvent,
  type OrderFile,
  orderStatus,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderEnvironment,
  recordOrderFile,
  recordOrderFinding,
} from "./factory-order";
import type { WorkerHookReport } from "./worker-environment";

/** How an order stopped: it landed, or it did not and goes back among the work
 *  nobody holds, carrying why. */
export type FactoryOutcome = {
  status: "completed" | "failed";
  reason?: string;
};

export type FactoryContext = {
  item: { id: string };
  baseRevision: string;
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

/** Only a completion projects a status; a failure hands the work back, which the
 *  event itself does. */
function stopEvent(outcome: FactoryOutcome): OrderEvent {
  return {
    kind: outcome.status,
    ...(outcome.status === "completed" ? { status: "completed" as const } : {}),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  };
}

export async function runFactoryOrder(
  db: Database,
  item: { id: string },
  options: { baseRevision: string; claim: OrderClaim; worktree?: string },
  build: FactoryBuilder,
): Promise<FactoryOutcome> {
  claimOrder(db, item.id, options.claim);

  const context: FactoryContext = {
    item,
    baseRevision: options.baseRevision,
    appendEvent: (event) => appendOrderEvent(db, item.id, event, undefined, options.worktree),
    delegate: (agentId, sessionId, station) =>
      appendOrderEvent(db, item.id, {
        kind: "delegated",
        delegatedAgentId: agentId,
        delegatedSessionId: sessionId,
        delegatedStation: station,
      }),
    stop: (outcome) => appendOrderEvent(db, item.id, stopEvent(outcome), undefined, options.worktree),
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
      appendOrderEvent(db, item.id, stopEvent(outcome), undefined, options.worktree);
    } else if (status !== outcome.status) {
      throw new Error(`order ${item.id} stopped as ${status} but builder returned ${outcome.status}`);
    }
    return outcome;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!isTerminalOrderStatus(orderStatus(db, item.id))) {
      try {
        appendOrderEvent(db, item.id, { kind: "failed", reason }, undefined, options.worktree);
      } catch (failureError) {
        throw new AggregateError([error, failureError], reason);
      }
    }
    throw error;
  }
}
