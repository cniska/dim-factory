import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import type { HarnessAdapter } from "./harness";
import {
  type HarnessLaunch,
  type HarnessLaunchResult,
  type HarnessStarted,
  launchHarnessLive,
  resumeHarnessLive,
  turnFailureDetail,
} from "./harness-launch";
import type { HarnessName } from "./harness-name";
import { finishAttempt, finishStoppedAttempt } from "./order-attempt";
import { fail, STATION_ROLES, type Station, type StationRole } from "./station-contract";
import { endWorker, rebindWorkerSession, startWorkerRun, workerProcessEnv } from "./worker";
import { bootstrapWorker, createWorkerAssignment, type WorkerAssignment } from "./worker-assignment";
import { route } from "./worker-routing";

export type BoundWorker = { name: string; providerSessionId: string; harness: HarnessName };

export type OrderWorker = {
  orderId: string;
  role: StationRole;
  assignment: WorkerAssignment;
  bound: BoundWorker | null;
};

export type ExecutionAttribution = { harness: HarnessLaunch["harness"]; model: string; tier: string };

export type WorkerTurn = { output: string; worker: OrderWorker & { bound: BoundWorker } };

export async function runWorkerTurn(
  db: Database,
  station: Station,
  request: HarnessLaunch,
  worker: OrderWorker,
  machine: Record<string, string | undefined> | undefined,
  adapter?: HarnessAdapter,
  onAssigned?: (worker: string, sessionId: string, attribution: ExecutionAttribution) => void,
): Promise<WorkerTurn> {
  let running: string | undefined;
  let session: string | undefined;
  const onStarted: HarnessStarted = (sessionId, pid, processStartedAt) => {
    session = sessionId;
    if (worker.bound) {
      if (onAssigned) finishStoppedAttempt(db, worker.orderId, new Date().toISOString());
      startWorkerRun(db, worker.bound.name, pid, processStartedAt);
      running = worker.bound.name;
      rebindWorkerSession(db, worker.bound.name, sessionId);
    } else {
      running = bootstrapWorker(db, {
        id: worker.assignment.id,
        sessionId,
        harness: request.harness,
        pid,
        processStartedAt,
      }).name;
    }
    const { tier, model } = route(worker.role, request.harness, machine);
    onAssigned?.(running, sessionId, { harness: request.harness, model, tier });
  };
  let result: HarnessLaunchResult;
  try {
    const env = workerProcessEnv(machine, worker.bound?.name);
    result = await (worker.bound
      ? resumeHarnessLive({ ...request, env }, worker.bound.providerSessionId, onStarted, adapter)
      : launchHarnessLive({ ...request, env }, onStarted, adapter));
  } catch (error) {
    releaseOrderWorker(db, worker.orderId, worker.role);
    throw error;
  } finally {
    if (running) endWorker(db, running);
  }
  if (!result.usageLimit && result.exitCode === 0 && running && session) {
    return {
      output: result.output,
      worker: { ...worker, bound: { name: running, providerSessionId: session, harness: request.harness } },
    };
  }
  releaseOrderWorker(db, worker.orderId, worker.role);
  const turn = { orderId: worker.orderId, station };
  if (result.usageLimit) {
    const { resetsAt } = result.usageLimit;
    finishAttempt(db, worker.orderId, "limited", result.failureReason, new Date().toISOString(), resetsAt);
    throw fail("usage_limited", { harness: request.harness, resetsAt: resetsAt ?? null });
  }
  if (result.exitCode !== 0) {
    throw fail("turn_unfinished", {
      ...turn,
      detail: turnFailureDetail(result.output, result.failureReason),
    });
  }
  throw fail("turn_unstarted", turn);
}

function readOrderWorker(db: Database, orderId: string, role: StationRole): OrderWorker | null {
  const row = db
    .query<
      {
        assignment_id: string;
        parent_worker: string;
        assignment_role: StationRole;
        created_at: string;
        worker: string | null;
        provider_session_id: string | null;
        harness: HarnessName | null;
      },
      [string, string]
    >(
      `SELECT ow.assignment_id, a.parent_worker, a.role AS assignment_role, a.created_at,
              w.name AS worker, w.provider_session_id, w.harness
       FROM factory_order_worker ow
       JOIN factory_worker_assignment a ON a.id = ow.assignment_id
       LEFT JOIN factory_worker w ON w.name = a.accepted_worker
       WHERE ow.order_id = ? AND ow.role = ?`,
    )
    .get(orderId, role);
  if (!row) return null;
  if (row.worker !== null && (row.provider_session_id === null || row.harness === null)) {
    throw fail("worker_sessionless", { orderId, role, worker: row.worker });
  }
  return {
    orderId,
    role,
    assignment: {
      id: row.assignment_id,
      parentWorker: row.parent_worker,
      role: row.assignment_role,
      createdAt: row.created_at,
    },
    bound:
      row.worker === null
        ? null
        : {
            name: row.worker,
            providerSessionId: row.provider_session_id as string,
            harness: row.harness as HarnessName,
          },
  };
}

export function releaseOrderWorker(db: Database, orderId: string, role: StationRole): void {
  const existing = readOrderWorker(db, orderId, role);
  if (!existing?.bound) return;
  writeTransaction(db, () => {
    const assignment = createWorkerAssignment(db, {
      parentWorker: existing.assignment.parentWorker,
      role,
    });
    const changed = db.run(
      "UPDATE factory_order_worker SET assignment_id = ? WHERE order_id = ? AND role = ? AND assignment_id = ?",
      [assignment.id, orderId, role, existing.assignment.id],
    );
    if (changed.changes !== 1) throw new Error(`order ${orderId} ${role} worker release was not writable`);
  });
}

export function boundStationHarness(db: Database, orderId: string, station: Station): HarnessName | null {
  return readOrderWorker(db, orderId, STATION_ROLES[station])?.bound?.harness ?? null;
}

export function ensureOrderWorker(
  db: Database,
  orderId: string,
  role: StationRole,
  parentWorker: string,
  harness: HarnessName,
  at = new Date().toISOString(),
): OrderWorker {
  const existing = readOrderWorker(db, orderId, role);
  if (existing?.bound && existing.bound.harness !== harness) {
    throw fail("harness_bound", { orderId, role, harness: existing.bound.harness });
  }
  if (existing) return existing;
  return writeTransaction(db, () => {
    const assignment = createWorkerAssignment(db, { parentWorker, role }, at);
    db.run(
      "INSERT INTO factory_order_worker (order_id, role, assignment_id, created_at) VALUES (?, ?, ?, ?)",
      [orderId, role, assignment.id, at],
    );
    return { orderId, role, assignment, bound: null };
  });
}
