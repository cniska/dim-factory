import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { writeTransaction } from "./db";
import { type MintedWorker, mintWorkerForSession } from "./worker";
import type { Role } from "./worker-roles";

export class WorkerAssignmentError extends Error {
  constructor(readonly code: "assignment_missing" | "assignment_used") {
    super(code);
  }
}

export type WorkerAssignment = {
  id: string;
  parentWorker: string;
  role: Role;
  createdAt: string;
};

const now = (): string => new Date().toISOString();

export function createWorkerAssignment(
  db: Database,
  assignment: { parentWorker: string; role: Role },
  at = now(),
): WorkerAssignment {
  const id = `assignment-${randomBytes(12).toString("hex")}`;
  db.run(
    `INSERT INTO factory_worker_assignment (id, parent_worker, role, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, assignment.parentWorker, assignment.role, at],
  );
  return { id, parentWorker: assignment.parentWorker, role: assignment.role, createdAt: at };
}

export function assignWorker(
  db: Database,
  assignment: { parentWorker: string; role: Role },
  at = now(),
): WorkerAssignment {
  return writeTransaction(db, () => createWorkerAssignment(db, assignment, at));
}

export function bootstrapWorker(
  db: Database,
  assignment: { id: string; sessionId: string; pid?: number; processStartedAt?: string },
  at = now(),
): MintedWorker {
  return writeTransaction(db, () => {
    const row = db
      .query<
        { parent_worker: string; role: Role; accepted_at: string | null; accepted_worker: string | null },
        [string]
      >(
        `SELECT parent_worker, role, accepted_at, accepted_worker
         FROM factory_worker_assignment WHERE id = ?`,
      )
      .get(assignment.id);
    if (!row) throw new WorkerAssignmentError("assignment_missing");
    if (row.accepted_at !== null) {
      const accepted = row.accepted_worker
        ? db
            .query<{ session_id: string; role: Role; parent_worker: string | null }, [string]>(
              "SELECT session_id, role, parent_worker FROM factory_worker WHERE name = ?",
            )
            .get(row.accepted_worker)
        : undefined;
      if (
        !accepted ||
        accepted.session_id !== assignment.sessionId ||
        accepted.role !== row.role ||
        accepted.parent_worker !== row.parent_worker
      ) {
        throw new WorkerAssignmentError("assignment_used");
      }
    }
    const minted = mintWorkerForSession(db, {
      role: row.role,
      parentWorker: row.parent_worker,
      sessionId: assignment.sessionId,
      pid: assignment.pid,
      processStartedAt: assignment.processStartedAt,
    });
    db.run(
      `UPDATE factory_worker_assignment
       SET accepted_at = ?, accepted_worker = ?
       WHERE id = ? AND accepted_at IS NULL`,
      [at, minted.name, assignment.id],
    );
    return minted;
  });
}
