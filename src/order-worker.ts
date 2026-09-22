import type { Database } from "bun:sqlite";
import { type MintedWorker, renewWorkerToken, workerProcessEnv } from "./factory-worker";
import type { Role } from "./roles";
import {
  assignmentProcessEnv,
  createWorkerAssignment,
  renewWorkerAssignment,
  type WorkerAssignment,
} from "./worker-assignment";

export type StationRole = Exclude<Role, "operator">;

export type OrderWorker = {
  orderId: string;
  role: StationRole;
  assignment: WorkerAssignment;
  worker?: string;
  providerSessionId?: string;
};

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
              ow.worker, ow.provider_session_id
       FROM factory_order_worker ow
       JOIN factory_worker_assignment a ON a.id = ow.assignment_id
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
    if (existing.assignment.parentWorker !== parentWorker) {
      throw new Error(
        `order ${orderId} ${role} worker belongs to ${existing.assignment.parentWorker}, not ${parentWorker}`,
      );
    }
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

export function orderWorkerRequest(
  db: Database,
  machine: Record<string, string | undefined> | undefined,
  orderWorker: OrderWorker,
): Record<string, string> {
  if (!orderWorker.worker) return assignmentProcessEnv(machine, orderWorker.assignment);
  const minted = renewWorkerToken(db, orderWorker.worker);
  return workerProcessEnv(machine, minted);
}
