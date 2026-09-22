import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  type MintedWorker,
  mintWorker,
  WORKER_NAME_VAR,
  WORKER_SESSION_VAR,
  WORKER_TOKEN_VAR,
} from "./factory-worker";
import type { Env } from "./paths";
import type { Role } from "./roles";

export const ASSIGNMENT_ID_VAR = "DIM_WORKER_ASSIGNMENT_ID";
export const ASSIGNMENT_TOKEN_VAR = "DIM_WORKER_ASSIGNMENT_TOKEN";

export class WorkerAssignmentError extends Error {
  constructor(readonly code: "assignment_missing" | "assignment_used" | "assignment_token") {
    super(code);
  }
}

export type WorkerAssignment = {
  id: string;
  token: string;
  parentWorker: string;
  role: Role;
  createdAt: string;
};

export function assignmentProcessEnv(
  machine: Env | undefined,
  assignment: Pick<WorkerAssignment, "id" | "token">,
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries({ ...process.env, ...machine }).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        ![
          WORKER_NAME_VAR,
          WORKER_TOKEN_VAR,
          WORKER_SESSION_VAR,
          ASSIGNMENT_ID_VAR,
          ASSIGNMENT_TOKEN_VAR,
        ].includes(entry[0]),
    ),
  );
  return {
    ...inherited,
    [ASSIGNMENT_ID_VAR]: assignment.id,
    [ASSIGNMENT_TOKEN_VAR]: assignment.token,
  };
}

const now = (): string => new Date().toISOString();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function assignWorker(
  db: Database,
  assignment: { parentWorker: string; role: Role },
  at = now(),
): WorkerAssignment {
  const id = `assignment-${randomBytes(12).toString("hex")}`;
  const token = randomBytes(24).toString("hex");
  db.run(
    `INSERT INTO factory_worker_assignment
       (id, parent_worker, role, token_digest, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, assignment.parentWorker, assignment.role, digest(token), at],
  );
  return { id, token, parentWorker: assignment.parentWorker, role: assignment.role, createdAt: at };
}

export function bootstrapWorker(
  db: Database,
  assignment: { id: string; token: string; sessionId: string; pid?: number },
  at = now(),
): MintedWorker {
  if (!assignment.token) throw new WorkerAssignmentError("assignment_token");
  return db.transaction(() => {
    const row = db
      .query<
        { parent_worker: string; role: Role; token_digest: string; accepted_at: string | null },
        [string]
      >(
        `SELECT parent_worker, role, token_digest, accepted_at
         FROM factory_worker_assignment WHERE id = ?`,
      )
      .get(assignment.id);
    if (!row) throw new WorkerAssignmentError("assignment_missing");
    if (row.accepted_at !== null) throw new WorkerAssignmentError("assignment_used");
    if (row.token_digest !== digest(assignment.token)) throw new WorkerAssignmentError("assignment_token");

    const minted = mintWorker(
      db,
      {
        role: row.role,
        parentWorker: row.parent_worker,
        sessionId: assignment.sessionId,
        pid: assignment.pid,
      },
      at,
    );
    db.run(
      `UPDATE factory_worker_assignment
       SET accepted_at = ?, accepted_worker = ?
       WHERE id = ? AND accepted_at IS NULL`,
      [at, minted.name, assignment.id],
    );
    return minted;
  })();
}

export function assignedWorker(db: Database, assignmentId: string): string | undefined {
  return (
    db
      .query<{ accepted_worker: string | null }, [string]>(
        "SELECT accepted_worker FROM factory_worker_assignment WHERE id = ?",
      )
      .get(assignmentId)?.accepted_worker ?? undefined
  );
}

export function resolveAssignedWorker(db: Database, env: Record<string, string | undefined>): string {
  const id = env[ASSIGNMENT_ID_VAR];
  const token = env[ASSIGNMENT_TOKEN_VAR];
  if (!id || !token) throw new WorkerAssignmentError("assignment_missing");
  const row = db
    .query<{ accepted_worker: string | null; token_digest: string }, [string]>(
      "SELECT accepted_worker, token_digest FROM factory_worker_assignment WHERE id = ?",
    )
    .get(id);
  if (!row) throw new WorkerAssignmentError("assignment_missing");
  if (row.token_digest !== digest(token)) throw new WorkerAssignmentError("assignment_token");
  if (!row.accepted_worker) throw new WorkerAssignmentError("assignment_used");
  return row.accepted_worker;
}
