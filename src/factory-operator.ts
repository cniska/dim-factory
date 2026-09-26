import type { Database } from "bun:sqlite";
import {
  type OrderFile,
  recordOrderCheck,
  recordOrderCommit,
  recordOrderDocument,
  recordOrderEnvironment,
  recordOrderFile,
} from "./factory-order-evidence";
import { appendOrderEvent } from "./factory-order-ledger";
import { claimOrder } from "./factory-order-lifecycle";
import { isTerminalOrderStatus, type OrderClaim, type OrderEvent, orderStatus } from "./factory-order-status";
import type { WorkerHookReport } from "./worker-environment";

export class OperatorActionRefused extends Error {
  constructor(
    readonly code: "worker_not_operator",
    message: string,
  ) {
    super(message);
  }
}

export function assertOperator(db: Database, worker: string, action: string): void {
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(worker)?.role;
  if (role !== "operator") {
    throw new OperatorActionRefused(
      "worker_not_operator",
      `${worker} cannot ${action}; the operator delegates it`,
    );
  }
}

export type FactoryOutcome = {
  status: "completed" | "failed";
  reason?: string;
};

export type FactoryContext = {
  item: { id: string };
  baseRevision: string;
  appendEvent(event: OrderEvent): void;
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
  recordDocument(path: string): void;
  recordEnvironment(report: WorkerHookReport): void;
};

export type FactoryBuilder = (context: FactoryContext) => FactoryOutcome | Promise<FactoryOutcome>;

function stopEvent(outcome: FactoryOutcome, worker: string): OrderEvent {
  return {
    kind: outcome.status,
    worker,
    ...(outcome.status === "completed" ? { status: "completed" as const } : {}),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  };
}

export async function runFactoryOrder(
  db: Database,
  item: { id: string },
  options: { baseRevision: string; claim: OrderClaim; worker: string; worktree?: string },
  build: FactoryBuilder,
): Promise<FactoryOutcome> {
  const { worker } = options;
  claimOrder(db, item.id, options.claim, worker, undefined, options.worktree);

  const context: FactoryContext = {
    item,
    baseRevision: options.baseRevision,
    appendEvent: (event) => appendOrderEvent(db, item.id, event, undefined, options.worktree),
    stop: (outcome) => appendOrderEvent(db, item.id, stopEvent(outcome, worker), undefined, options.worktree),
    recordCommit: (sha, subject) => recordOrderCommit(db, item.id, sha, worker, subject),
    recordFile: (file) => recordOrderFile(db, item.id, file, worker),
    recordCheck: (check) => recordOrderCheck(db, item.id, check, worker),
    recordDocument: (path) => recordOrderDocument(db, item.id, path, worker),
    recordEnvironment: (report) => recordOrderEnvironment(db, item.id, report),
  };

  try {
    const outcome = await build(context);
    const status = orderStatus(db, item.id);
    if (!isTerminalOrderStatus(status)) {
      appendOrderEvent(db, item.id, stopEvent(outcome, worker), undefined, options.worktree);
    } else if (status !== outcome.status) {
      throw new Error(`order ${item.id} stopped as ${status} but builder returned ${outcome.status}`);
    }
    return outcome;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!isTerminalOrderStatus(orderStatus(db, item.id))) {
      try {
        appendOrderEvent(db, item.id, { kind: "failed", worker, reason }, undefined, options.worktree);
      } catch (failureError) {
        throw new AggregateError([error, failureError], reason);
      }
    }
    throw error;
  }
}
