import type { Database } from "bun:sqlite";
import { type MintedWorker, resolveWorker, workerProcessEnv } from "./factory-worker";
import type { HarnessAdapter } from "./harness";
import {
  type HarnessCommandRequest,
  type HarnessStarted,
  runHarnessCommandLive,
  runHarnessCommandResumeLive,
} from "./harness-command";
import type { Role } from "./roles";
import {
  assignedWorker,
  assignmentProcessEnv,
  bootstrapWorker,
  createWorkerAssignment,
  renewWorkerAssignment,
  type WorkerAssignment,
} from "./worker-assignment";
import { readWorkerCredential, saveWorkerCredential } from "./worker-credential";

export type StationRole = Exclude<Role, "operator">;

export type OrderWorker = {
  orderId: string;
  role: StationRole;
  assignment: WorkerAssignment;
  worker?: string;
  providerSessionId?: string;
};

export function runOrderWorkerHarnessLive(
  db: Database,
  request: HarnessCommandRequest,
  worker: OrderWorker,
  machine: Record<string, string | undefined> | undefined,
  adapter?: HarnessAdapter,
  onAssigned?: (worker: string, sessionId: string) => void,
): Promise<Awaited<ReturnType<typeof runHarnessCommandLive>> & { worker?: string }> {
  const env = orderWorkerRequest(db, machine, worker);
  let name = worker.worker;
  const onStarted: HarnessStarted = (sessionId) => {
    if (name) {
      bindOrderWorkerSession(db, worker.orderId, worker.role, sessionId);
    } else {
      const minted = bootstrapWorker(db, {
        id: worker.assignment.id,
        token: worker.assignment.token,
        sessionId,
      });
      saveWorkerCredential(machine ?? process.env, minted);
      bindOrderWorker(db, worker.orderId, worker.role, worker.assignment.id, minted);
      name = minted.name;
    }
    onAssigned?.(name, sessionId);
  };
  const run = worker.providerSessionId
    ? runHarnessCommandResumeLive({ ...request, env }, worker.providerSessionId, onStarted, adapter)
    : runHarnessCommandLive({ ...request, env }, onStarted, adapter);
  return run.then((result) => ({
    ...result,
    worker: name ?? assignedWorker(db, worker.assignment.id) ?? undefined,
  }));
}

function readOrderWorker(db: Database, orderId: string, role: StationRole): OrderWorker | undefined {
  const row = db
    .query<
      {
        assignment_id: string;
        parent_worker: string;
        assignment_role: StationRole;
        created_at: string;
        worker: string | null;
        provider_session_id: string | null;
      },
      [string, string]
    >(
      `SELECT ow.assignment_id, a.parent_worker, a.role AS assignment_role, a.created_at,
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
      token: "",
      parentWorker: row.parent_worker,
      role: row.assignment_role,
      createdAt: row.created_at,
    },
    worker: row.worker ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
  };
}

export function ensureOrderWorker(
  db: Database,
  orderId: string,
  role: StationRole,
  parentWorker: string,
  at = new Date().toISOString(),
): OrderWorker {
  const existing = readOrderWorker(db, orderId, role);
  if (existing) {
    if (existing.worker) {
      return existing;
    }
    return {
      ...existing,
      assignment: renewWorkerAssignment(db, existing.assignment.id),
    };
  }

  return db.transaction(() => {
    const assignment = createWorkerAssignment(db, { parentWorker, role }, at);
    db.run(
      `INSERT INTO factory_order_worker
       (order_id, role, assignment_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [orderId, role, assignment.id, at],
    );
    return { orderId, role, assignment };
  })();
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

export function bindOrderWorkerName(
  db: Database,
  orderId: string,
  role: StationRole,
  assignmentId: string,
  worker: string,
): void {
  const session = db
    .query<{ session_id: string }, [string]>("SELECT session_id FROM factory_worker WHERE name = ?")
    .get(worker);
  if (!session) throw new Error(`worker ${worker} was not registered`);
  const result = db.run(
    `UPDATE factory_order_worker
     SET worker = ?, provider_session_id = ?
     WHERE order_id = ? AND role = ? AND assignment_id = ? AND worker IS NULL`,
    [worker, session.session_id, orderId, role, assignmentId],
  );
  if (result.changes !== 1) {
    const existing = readOrderWorker(db, orderId, role);
    if (existing?.worker === worker && existing.providerSessionId === session.session_id) return;
    throw new Error(`order ${orderId} ${role} worker binding was not writable`);
  }
}

export function bindOrderWorkerSession(
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

export function orderWorkerRequest(
  db: Database,
  machine: Record<string, string | undefined> | undefined,
  orderWorker: OrderWorker,
): Record<string, string> {
  if (!orderWorker.worker) return assignmentProcessEnv(machine, orderWorker.assignment);
  if (!orderWorker.providerSessionId) {
    throw new Error(`order ${orderWorker.orderId} ${orderWorker.role} worker has no provider session`);
  }
  const credential = readWorkerCredential(machine ?? process.env, orderWorker.providerSessionId);
  if (credential?.name !== orderWorker.worker) {
    throw new Error(`order ${orderWorker.orderId} ${orderWorker.role} worker credential is unavailable`);
  }
  const env = workerProcessEnv(machine, credential);
  if (resolveWorker(db, env) !== orderWorker.worker) {
    throw new Error(`order ${orderWorker.orderId} ${orderWorker.role} worker credential changed identity`);
  }
  return env;
}
