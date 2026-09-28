import { type Database, SQLiteError } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { writeTransaction } from "./db";
import type { Env } from "./paths";
import { type ProcessIdentity, processAncestry, processStartTime } from "./pid";
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
  worker: { role: Role; parentWorker?: string; pid?: number; processStartedAt?: string; sessionId: string },
  at = now(),
): MintedWorker {
  const sessionId = worker.sessionId;
  if (!sessionId || sessionId.trim() === "") throw new Error("worker session id is required");
  const processStartedAt =
    worker.pid === undefined ? null : (worker.processStartedAt ?? processStartTime(worker.pid));
  if (worker.pid !== undefined && !processStartedAt) {
    throw new Error(`cannot read start time for worker pid ${worker.pid}`);
  }
  const token = randomBytes(16).toString("hex");
  return writeTransaction(db, () => {
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
        "INSERT INTO factory_worker (name, role, parent_worker, session_id, token_digest, pid, process_started_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          name,
          worker.role ?? null,
          worker.parentWorker ?? null,
          sessionId,
          digest(token),
          worker.pid ?? null,
          processStartedAt,
          at,
        ],
      );
    } catch (error) {
      if (
        error instanceof SQLiteError &&
        error.code === "SQLITE_CONSTRAINT_UNIQUE" &&
        db
          .query<{ name: string }, [string]>("SELECT name FROM factory_worker WHERE session_id = ?")
          .get(sessionId)
      ) {
        throw new WorkerSessionTaken(`session ${sessionId} already has a factory identity`);
      }
      throw error;
    }
    return { name, token, sessionId };
  });
}

type WorkerRow = {
  name: string;
  pid: number | null;
  process_started_at: string | null;
  ended_at: string | null;
};

type CredentialRow = WorkerRow & { token_digest: string };

export function assertLiveWorker(
  row: Pick<WorkerRow, "name" | "pid" | "process_started_at" | "ended_at">,
  observed?: ProcessIdentity,
): void {
  if (row.ended_at !== null) {
    throw new WorkerUnknown("worker_over", `worker ${row.name} ended at ${row.ended_at}`);
  }
  if (
    row.pid === null ||
    row.process_started_at === null ||
    (observed?.startedAt ?? processStartTime(row.pid)) !== row.process_started_at
  ) {
    throw new WorkerUnknown("worker_over", `worker ${row.name}'s registered process is gone`);
  }
}

export type RegisteredCaller = { kind: "worker"; worker: WorkerRow } | { kind: "barrier" };

export function registeredCaller(
  db: Database,
  ancestry: readonly ProcessIdentity[],
): RegisteredCaller | null {
  for (const process of ancestry) {
    const barrier = db
      .query<{ process_started_at: string }, [number]>(
        "SELECT process_started_at FROM factory_runner_barrier WHERE pid = ?",
      )
      .get(process.pid);
    if (barrier?.process_started_at === process.startedAt) return { kind: "barrier" };
    const worker = db
      .query<WorkerRow, [number, string]>(
        `SELECT name, pid, process_started_at, ended_at FROM factory_worker
         WHERE pid = ? AND process_started_at = ? ORDER BY ended_at IS NOT NULL LIMIT 1`,
      )
      .get(process.pid, process.startedAt);
    if (worker) return { kind: "worker", worker };
  }
  return null;
}

export function resolveWorker(
  db: Database,
  ancestry: readonly ProcessIdentity[] = processAncestry(),
): string {
  const registered = registeredCaller(db, ancestry);
  if (!registered || registered.kind === "barrier") {
    throw new WorkerUnknown("worker_missing", "no live worker owns this process");
  }
  const process = ancestry.find((one) => one.pid === registered.worker.pid);
  assertLiveWorker(registered.worker, process);
  return registered.worker.name;
}

export function authenticateWorker(db: Database, env: Env): CredentialRow {
  const name = env[WORKER_NAME_VAR];
  const token = env[WORKER_TOKEN_VAR];
  if (!name || !token) {
    throw new WorkerUnknown("worker_missing", "worker credential is missing");
  }
  const row = db
    .query<CredentialRow, [string]>(
      "SELECT name, token_digest, pid, process_started_at, ended_at FROM factory_worker WHERE name = ?",
    )
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
    processStartedAt?: string;
    parentWorker?: string;
    credential?: MintedWorker | null;
  },
): MintedWorker {
  return writeTransaction(db, () => {
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
      throw new Error(`worker ${existing.name} does not belong to assignment parent ${worker.parentWorker}`);
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
    authenticateWorker(db, {
      [WORKER_NAME_VAR]: worker.credential.name,
      [WORKER_TOKEN_VAR]: worker.credential.token,
    });
    return worker.credential;
  });
}

export function workerIsOver(db: Database, name: string): boolean {
  const row = db
    .query<{ pid: number | null; process_started_at: string | null; ended_at: string | null }, [string]>(
      "SELECT pid, process_started_at, ended_at FROM factory_worker WHERE name = ?",
    )
    .get(name);
  if (!row) return true;
  if (row.ended_at !== null) return true;
  if (row.pid === null || row.process_started_at === null) return true;
  return processStartTime(row.pid) !== row.process_started_at;
}

export function startWorkerRun(db: Database, name: string, pid: number, processStartedAt?: string): void {
  const startedAt = processStartedAt ?? processStartTime(pid);
  if (!startedAt) throw new Error(`cannot read start time for worker pid ${pid}`);
  const done = db.run(
    "UPDATE factory_worker SET pid = ?, process_started_at = ?, ended_at = NULL WHERE name = ?",
    [pid, startedAt, name],
  );
  if (done.changes !== 1) throw new Error(`worker ${name} was not registered`);
}

export function registerRunnerBarrier(db: Database, pid = process.pid): void {
  const startedAt = processStartTime(pid);
  if (!startedAt) throw new Error(`cannot read start time for runner pid ${pid}`);
  db.run(
    `INSERT INTO factory_runner_barrier (pid, process_started_at) VALUES (?, ?)
     ON CONFLICT(pid) DO UPDATE SET process_started_at = excluded.process_started_at`,
    [pid, startedAt],
  );
}

export function clearRunnerBarrier(db: Database, pid = process.pid): void {
  db.run("DELETE FROM factory_runner_barrier WHERE pid = ?", [pid]);
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
