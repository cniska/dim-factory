import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { Env } from "./paths";
import { pidIsAlive } from "./pid";
import { randomWorkerName } from "./worker-name";
import type { Role } from "./worker-roles";

export const WORKER_NAME_VAR = "DIM_WORKER_NAME";
export const WORKER_TOKEN_VAR = "DIM_WORKER_TOKEN";
export const WORKER_SESSION_VAR = "DIM_SESSION_ID";

export type WorkerUnknownCode = "worker_missing" | "worker_unissued" | "worker_over";

export class WorkerSessionTaken extends Error {
  readonly code = "worker_session_taken";
}

export class WorkerCredentialUnavailable extends Error {
  readonly code = "worker_credential_unavailable";
}

export class WorkerUnknown extends Error {
  constructor(
    readonly code: WorkerUnknownCode,
    message: string,
  ) {
    super(message);
  }
}

export type MintedWorker = { name: string; token: string; sessionId: string };

export function workerProcessEnv(machine: Env | undefined, worker: MintedWorker): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(machine ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...inherited,
    [WORKER_NAME_VAR]: worker.name,
    [WORKER_TOKEN_VAR]: worker.token,
    [WORKER_SESSION_VAR]: worker.sessionId,
  };
}

const now = (): string => new Date().toISOString();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintWorker(
  db: Database,
  worker: { role: Role; parentWorker?: string; pid?: number; sessionId: string },
  at = now(),
): MintedWorker {
  const sessionId = worker.sessionId;
  if (!sessionId || sessionId.trim() === "") throw new Error("worker session id is required");
  const token = randomBytes(16).toString("hex");
  return db.transaction(() => {
    if (worker.parentWorker !== undefined) {
      const parent = db
        .query<{ name: string }, [string]>("SELECT name FROM factory_worker WHERE name = ?")
        .get(worker.parentWorker);
      if (!parent) throw new Error(`parent worker ${worker.parentWorker} does not exist`);
    }
    const held = db.query<{ name: string }, []>("SELECT name FROM factory_worker").all();
    const name = randomWorkerName(new Set(held.map((row) => row.name)));
    try {
      db.run(
        "INSERT INTO factory_worker (name, role, parent_worker, session_id, token_digest, pid, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          name,
          worker.role ?? null,
          worker.parentWorker ?? null,
          sessionId,
          digest(token),
          worker.pid ?? null,
          at,
        ],
      );
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: factory_worker.session_id")) {
        throw new WorkerSessionTaken(`session ${sessionId} already has a factory identity`);
      }
      throw error;
    }
    return { name, token, sessionId };
  })();
}

type WorkerRow = { name: string; token_digest: string; pid: number | null; ended_at: string | null };

export function resolveWorker(db: Database, env: Env = process.env): string {
  const row = authenticateWorker(db, env);
  if (row.ended_at !== null) {
    throw new WorkerUnknown("worker_over", `worker ${row.name} ended at ${row.ended_at}`);
  }
  if (row.pid !== null && !pidIsAlive(row.pid)) {
    throw new WorkerUnknown("worker_over", `worker ${row.name} ran as pid ${row.pid}, which is gone`);
  }
  return row.name;
}

export function authenticateWorker(db: Database, env: Env): WorkerRow {
  const name = env[WORKER_NAME_VAR];
  const token = env[WORKER_TOKEN_VAR];
  if (!name || !token) {
    throw new WorkerUnknown(
      "worker_missing",
      `nothing says which worker this is: ${WORKER_NAME_VAR} and ${WORKER_TOKEN_VAR} identify a ` +
        "station worker; operators resolve their identity with `dim operator`.",
    );
  }
  const row = db
    .query<WorkerRow, [string]>("SELECT name, token_digest, pid, ended_at FROM factory_worker WHERE name = ?")
    .get(name);
  if (!row || row.token_digest !== digest(token)) {
    throw new WorkerUnknown("worker_unissued", `this factory issued no worker ${name}`);
  }
  return row;
}

export function mintWorkerForSession(
  db: Database,
  worker: {
    role: Role;
    sessionId: string;
    pid?: number;
    parentWorker?: string;
    credential?: MintedWorker | null;
  },
): MintedWorker {
  return db
    .transaction(() => {
      const existing = db
        .query<{ name: string; role: Role; parent_worker: string | null; ended_at: string | null }, [string]>(
          "SELECT name, role, parent_worker, ended_at FROM factory_worker WHERE session_id = ?",
        )
        .get(worker.sessionId);
      if (!existing) return mintWorker(db, worker);
      if (existing.role !== worker.role) {
        throw new Error(`this factory session already carries ${existing.role}, not ${worker.role}`);
      }
      if (worker.parentWorker !== undefined && existing.parent_worker !== worker.parentWorker) {
        throw new Error(
          `worker ${existing.name} does not belong to assignment parent ${worker.parentWorker}`,
        );
      }
      if (existing.ended_at !== null)
        throw new WorkerUnknown("worker_over", `worker ${existing.name} has ended`);
      if (!worker.credential) {
        throw new WorkerCredentialUnavailable(
          `the credential for worker ${existing.name} in session ${worker.sessionId} is unavailable`,
        );
      }
      if (worker.credential.name !== existing.name || worker.credential.sessionId !== worker.sessionId) {
        throw new WorkerCredentialUnavailable(
          `the saved credential does not belong to session ${worker.sessionId}`,
        );
      }
      resolveWorker(db, {
        [WORKER_NAME_VAR]: worker.credential.name,
        [WORKER_TOKEN_VAR]: worker.credential.token,
      });
      return worker.credential;
    })
    .immediate();
}

export function workerIsOver(db: Database, name: string): boolean {
  const row = db
    .query<{ role: Role; pid: number | null; ended_at: string | null }, [string]>(
      "SELECT role, pid, ended_at FROM factory_worker WHERE name = ?",
    )
    .get(name);
  if (!row) return true;
  if (row.ended_at !== null) return true;
  if (row.pid === null) return row.role !== "operator";
  return !pidIsAlive(row.pid);
}

export function startWorkerRun(db: Database, name: string, pid: number): void {
  const done = db.run("UPDATE factory_worker SET pid = ?, ended_at = NULL WHERE name = ?", [pid, name]);
  if (done.changes !== 1) throw new Error(`worker ${name} was not registered`);
}

export function endWorker(db: Database, name: string, at = now()): boolean {
  const done = db.run("UPDATE factory_worker SET ended_at = ? WHERE name = ? AND ended_at IS NULL", [
    at,
    name,
  ]);
  return done.changes === 1;
}

export function workerExports(minted: MintedWorker): string {
  return (
    `export ${WORKER_SESSION_VAR}=${minted.sessionId}\n` +
    `export ${WORKER_NAME_VAR}=${minted.name}\nexport ${WORKER_TOKEN_VAR}=${minted.token}`
  );
}

export function newWorkerSession(prefix = "session"): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}
