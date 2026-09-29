import { type Database, SQLiteError } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { writeTransaction } from "./db";
import type { Env } from "./paths";
import { type ProcessIdentity, processAncestry, processStartTime } from "./pid";
import { randomWorkerName, WORKER_NAME_VAR } from "./worker-name";
import type { Role } from "./worker-roles";

export type WorkerUnknownCode = "worker_missing" | "worker_unissued" | "worker_over";

export class WorkerSessionTaken extends Error {
  readonly code = "worker_session_taken";
}

export class WorkerUnknown extends Error {
  constructor(
    readonly code: WorkerUnknownCode,
    message: string,
  ) {
    super(message);
  }
}

export type MintedWorker = { name: string; sessionId: string };

export function workerProcessEnv(
  machine: Env | undefined,
  worker: string | undefined,
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(machine ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== WORKER_NAME_VAR,
    ),
  );
  return worker ? { ...inherited, [WORKER_NAME_VAR]: worker } : inherited;
}

const now = (): string => new Date().toISOString();

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
        "INSERT INTO factory_worker (name, role, parent_worker, session_id, pid, process_started_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          name,
          worker.role ?? null,
          worker.parentWorker ?? null,
          sessionId,
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
    return { name, sessionId };
  });
}

type WorkerRow = {
  name: string;
  pid: number | null;
  process_started_at: string | null;
  ended_at: string | null;
};

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

export function mintWorkerForSession(
  db: Database,
  worker: {
    role: Role;
    sessionId: string;
    pid?: number;
    processStartedAt?: string;
    parentWorker?: string;
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
    if (worker.pid !== undefined) startWorkerRun(db, existing.name, worker.pid, worker.processStartedAt);
    return { name: existing.name, sessionId: worker.sessionId };
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

export function rebindWorkerSession(db: Database, name: string, providerSessionId: string): void {
  const done = db.run(
    "UPDATE factory_worker SET provider_session_id = ? WHERE name = ? AND harness IS NOT NULL",
    [providerSessionId, name],
  );
  if (done.changes !== 1) throw new Error(`worker ${name} has no provider session to rebind`);
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

export function withRunnerBarrier<T>(db: Database, run: () => T): T {
  registerRunnerBarrier(db);
  try {
    return run();
  } finally {
    clearRunnerBarrier(db);
  }
}

export function endWorker(db: Database, name: string, at = now()): boolean {
  const done = db.run("UPDATE factory_worker SET ended_at = ? WHERE name = ? AND ended_at IS NULL", [
    at,
    name,
  ]);
  return done.changes === 1;
}

export function newWorkerSession(prefix = "session"): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}
