import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { HarnessName } from "./harness-name";
import { ROLES, type Role, type Worker, type WorkerSession } from "./worker-contract";

export const WORKER_SQL = `
CREATE TABLE IF NOT EXISTS worker (
  name        TEXT PRIMARY KEY CHECK (name GLOB '[a-z]*-[0-9]*'),
  role        TEXT NOT NULL CHECK (role IN ('operator','planner','builder','reviewer')),
  project     TEXT NOT NULL,
  order_id    TEXT,
  created_by  TEXT REFERENCES worker(name),
  created_at  TEXT NOT NULL,
  CHECK ((role = 'operator') = (order_id IS NULL AND created_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_station ON worker(order_id, role) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS worker_operator ON worker(project) WHERE role = 'operator';
CREATE TABLE IF NOT EXISTS worker_session (
  id              TEXT PRIMARY KEY,
  worker          TEXT NOT NULL REFERENCES worker(name),
  harness         TEXT NOT NULL,
  pid             INTEGER NOT NULL,
  pid_started_at  TEXT NOT NULL,
  registered_at   TEXT NOT NULL
);
`;

type WorkerRow = {
  readonly name: string;
  readonly role: string;
  readonly project: string;
  readonly order_id: string | null;
  readonly created_by: string | null;
};

type SessionRow = {
  readonly id: string;
  readonly worker: string;
  readonly harness: string;
  readonly pid: number;
  readonly pid_started_at: string;
};

function roleOf(value: string): Role {
  const role = ROLES.find((known) => known === value);
  invariant(role !== undefined, `worker role ${value} is one the table allows`);
  return role;
}

function workerOf(row: WorkerRow): Worker {
  const role = roleOf(row.role);
  if (role === "operator") return { role, name: row.name, project: row.project };
  invariant(row.order_id !== null && row.created_by !== null, `station worker ${row.name} has an order`);
  return { role, name: row.name, project: row.project, order: row.order_id, createdBy: row.created_by };
}

const sessionOf = (row: SessionRow): WorkerSession => ({
  id: row.id,
  worker: row.worker,
  harness: HarnessName.parse(row.harness),
  process: { pid: row.pid, startedAt: row.pid_started_at },
});

export function insertWorker(db: Database, worker: Worker, at: string): void {
  const [order, createdBy] = worker.role === "operator" ? [null, null] : [worker.order, worker.createdBy];
  db.run(
    "INSERT INTO worker (name, role, project, order_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [worker.name, worker.role, worker.project, order, createdBy, at],
  );
}

export function insertSession(db: Database, session: WorkerSession, at: string): void {
  db.run(
    "INSERT INTO worker_session (id, worker, harness, pid, pid_started_at, registered_at) VALUES (?, ?, ?, ?, ?, ?)",
    [session.id, session.worker, session.harness, session.process.pid, session.process.startedAt, at],
  );
}

export function workerNames(db: Database): ReadonlySet<string> {
  return new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM worker")
      .all()
      .map((row) => row.name),
  );
}

export function workerNamed(db: Database, name: string): Worker | null {
  const row = db
    .query<WorkerRow, [string]>("SELECT name, role, project, order_id, created_by FROM worker WHERE name = ?")
    .get(name);
  return row === null ? null : workerOf(row);
}

export function stationWorkerOf(db: Database, order: string, role: Role): Worker | null {
  const row = db
    .query<WorkerRow, [string, string]>(
      "SELECT name, role, project, order_id, created_by FROM worker WHERE order_id = ? AND role = ?",
    )
    .get(order, role);
  return row === null ? null : workerOf(row);
}

export function sessionNamed(db: Database, id: string): WorkerSession | null {
  const row = db
    .query<SessionRow, [string]>(
      "SELECT id, worker, harness, pid, pid_started_at FROM worker_session WHERE id = ?",
    )
    .get(id);
  return row === null ? null : sessionOf(row);
}

export function sessionsOf(db: Database, worker: string): readonly WorkerSession[] {
  return db
    .query<SessionRow, [string]>(
      "SELECT id, worker, harness, pid, pid_started_at FROM worker_session WHERE worker = ? ORDER BY rowid",
    )
    .all(worker)
    .map(sessionOf);
}

export function sessions(db: Database): readonly WorkerSession[] {
  return db
    .query<SessionRow, []>(
      "SELECT id, worker, harness, pid, pid_started_at FROM worker_session ORDER BY rowid",
    )
    .all()
    .map(sessionOf);
}

export function operatorOf(db: Database, project: string): Worker | null {
  const row = db
    .query<WorkerRow, [string]>(
      "SELECT name, role, project, order_id, created_by FROM worker WHERE role = 'operator' AND project = ?",
    )
    .get(project);
  return row === null ? null : workerOf(row);
}
