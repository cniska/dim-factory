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
import { endWorker, type MintedWorker, startWorkerRun, workerProcessEnv } from "./worker";
import { bootstrapWorker, createWorkerAssignment, type WorkerAssignment } from "./worker-assignment";
import { route } from "./worker-routing";

export type OrderWorker = {
  orderId: string;
  role: StationRole;
  assignment: WorkerAssignment;
  worker?: string;
  providerSessionId?: string;
  harness: HarnessName;
};

export type ExecutionAttribution = { harness: HarnessLaunch["harness"]; model: string; tier: string };

export type WorkerTurn = { output: string; worker: string; bound: OrderWorker };

export async function runWorkerTurn(
  db: Database,
  station: Station,
  request: HarnessLaunch,
  worker: OrderWorker,
  machine: Record<string, string | undefined> | undefined,
  adapter?: HarnessAdapter,
  onAssigned?: (worker: string, sessionId: string, attribution: ExecutionAttribution) => void,
): Promise<WorkerTurn> {
  let name = worker.worker;
  let running: string | undefined;
  let session: string | undefined;
  const onStarted: HarnessStarted = (sessionId, pid, processStartedAt) => {
    session = sessionId;
    if (name) {
      if (onAssigned) finishStoppedAttempt(db, worker.orderId, new Date().toISOString());
      startWorkerRun(db, name, pid, processStartedAt);
      running = name;
      bindOrderWorkerSession(db, worker.orderId, worker.role, sessionId);
    } else {
      const minted = bootstrapWorker(db, {
        id: worker.assignment.id,
        sessionId,
        pid,
        processStartedAt,
      });
      running = minted.name;
      bindOrderWorker(db, worker.orderId, worker.role, worker.assignment.id, minted);
      name = minted.name;
    }
    const { tier, model } = route(worker.role, request.harness, machine);
    onAssigned?.(name, sessionId, { harness: request.harness, model, tier });
  };
  let result: HarnessLaunchResult;
  try {
    const env = orderWorkerRequest(machine, worker);
    result = await (worker.providerSessionId
      ? resumeHarnessLive({ ...request, env }, worker.providerSessionId, onStarted, adapter)
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
      worker: running,
      bound: { ...worker, worker: running, providerSessionId: session },
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

export function readOrderWorker(db: Database, orderId: string, role: StationRole): OrderWorker | undefined {
  const row = db
    .query<
      {
        assignment_id: string;
        parent_worker: string;
        assignment_role: StationRole;
        created_at: string;
        worker: string | null;
        provider_session_id: string | null;
        harness: HarnessName;
      },
      [string, string]
    >(
      `SELECT ow.assignment_id, a.parent_worker, a.role AS assignment_role, a.created_at, ow.harness,
              coalesce(ow.worker, a.accepted_worker) AS worker,
              coalesce(ow.provider_session_id, w.session_id) AS provider_session_id
       FROM factory_order_worker ow
       JOIN factory_worker_assignment a ON a.id = ow.assignment_id
       LEFT JOIN factory_worker w ON w.name = a.accepted_worker
       WHERE ow.order_id = ? AND ow.role = ?`,
    )
    .get(orderId, role);
  if (!row) return undefined;
  return {
    orderId,
    role,
    assignment: {
      id: row.assignment_id,
      parentWorker: row.parent_worker,
      role: row.assignment_role,
      createdAt: row.created_at,
    },
    worker: row.worker ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    harness: row.harness,
  };
}

function refuseHarnessSwitch(existing: OrderWorker | undefined, harness: HarnessName): void {
  if (existing?.worker && existing.harness !== harness) {
    throw new Error(
      `order ${existing.orderId} ${existing.role} runs under the ${existing.harness} harness; delegate it with --harness ${existing.harness}`,
    );
  }
}

export function releaseOrderWorker(db: Database, orderId: string, role: StationRole): void {
  const existing = readOrderWorker(db, orderId, role);
  if (!existing?.worker) return;
  writeTransaction(db, () => {
    const assignment = createWorkerAssignment(db, {
      parentWorker: existing.assignment.parentWorker,
      role,
    });
    const changed = db.run(
      `UPDATE factory_order_worker
       SET assignment_id = ?, worker = NULL, provider_session_id = NULL
       WHERE order_id = ? AND role = ? AND assignment_id = ?`,
      [assignment.id, orderId, role, existing.assignment.id],
    );
    if (changed.changes !== 1) throw new Error(`order ${orderId} ${role} worker release was not writable`);
  });
}

export function boundStationHarness(
  db: Database,
  orderId: string,
  station: Station,
): HarnessName | undefined {
  const bound = readOrderWorker(db, orderId, STATION_ROLES[station]);
  return bound?.worker ? bound.harness : undefined;
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
  refuseHarnessSwitch(existing, harness);
  if (existing) {
    if (existing.worker) return existing;
    return writeTransaction(db, () => {
      db.run("UPDATE factory_order_worker SET harness = ? WHERE order_id = ? AND role = ?", [
        harness,
        orderId,
        role,
      ]);
      return { ...existing, harness };
    });
  }

  return writeTransaction(db, () => {
    const assignment = createWorkerAssignment(db, { parentWorker, role }, at);
    db.run(
      `INSERT INTO factory_order_worker
       (order_id, role, assignment_id, harness, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [orderId, role, assignment.id, harness, at],
    );
    return { orderId, role, assignment, harness };
  });
}

export function bindOrderWorker(
  db: Database,
  orderId: string,
  role: StationRole,
  assignmentId: string,
  worker: MintedWorker,
): void {
  const result = db.run(
    `UPDATE factory_order_worker
     SET worker = ?, provider_session_id = ?
     WHERE order_id = ? AND role = ? AND assignment_id = ? AND worker IS NULL`,
    [worker.name, worker.sessionId, orderId, role, assignmentId],
  );
  if (result.changes !== 1) {
    const existing = readOrderWorker(db, orderId, role);
    if (existing?.worker === worker.name && existing.providerSessionId === worker.sessionId) return;
    throw new Error(`order ${orderId} ${role} worker binding was not writable`);
  }
}

function bindOrderWorkerSession(
  db: Database,
  orderId: string,
  role: StationRole,
  providerSessionId: string,
): void {
  const result = db.run(
    `UPDATE factory_order_worker
     SET provider_session_id = ?
     WHERE order_id = ? AND role = ? AND worker IS NOT NULL`,
    [providerSessionId, orderId, role],
  );
  if (result.changes !== 1) throw new Error(`order ${orderId} ${role} worker session was not writable`);
}

function orderWorkerRequest(
  machine: Record<string, string | undefined> | undefined,
  orderWorker: OrderWorker,
): Record<string, string> {
  if (orderWorker.worker && !orderWorker.providerSessionId) {
    throw new Error(`order ${orderWorker.orderId} ${orderWorker.role} worker has no provider session`);
  }
  return workerProcessEnv(machine, orderWorker.worker);
}
