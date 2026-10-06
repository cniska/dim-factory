import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { HarnessName } from "./harness-contract";
import { ROLES, type Role, type Tokens, type Worker, type WorkerSession } from "./worker-contract";

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

const WORKER = "SELECT name, role, project, order_id, created_by FROM worker";

const SESSION = "SELECT id, worker, harness, pid, pid_started_at FROM worker_session";

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

export function insertWorker(db: Database, worker: Worker): void {
  const [order, createdBy] = worker.role === "operator" ? [null, null] : [worker.order, worker.createdBy];
  db.run("INSERT INTO worker (name, role, project, order_id, created_by) VALUES (?, ?, ?, ?, ?)", [
    worker.name,
    worker.role,
    worker.project,
    order,
    createdBy,
  ]);
}

export function insertSession(db: Database, session: WorkerSession): void {
  db.run("INSERT INTO worker_session (id, worker, harness, pid, pid_started_at) VALUES (?, ?, ?, ?, ?)", [
    session.id,
    session.worker,
    session.harness,
    session.process.pid,
    session.process.startedAt,
  ]);
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
  const row = db.query<WorkerRow, [string]>(`${WORKER} WHERE name = ?`).get(name);
  return row === null ? null : workerOf(row);
}

export function stationWorkerOf(db: Database, order: string, role: Role): Worker | null {
  const row = db
    .query<WorkerRow, [string, string]>(`${WORKER} WHERE order_id = ? AND role = ?`)
    .get(order, role);
  return row === null ? null : workerOf(row);
}

export function sessionNamed(db: Database, id: string): WorkerSession | null {
  const row = db.query<SessionRow, [string]>(`${SESSION} WHERE id = ?`).get(id);
  return row === null ? null : sessionOf(row);
}

export function sessionsOf(db: Database, worker: string): readonly WorkerSession[] {
  return db
    .query<SessionRow, [string]>(`${SESSION} WHERE worker = ? ORDER BY rowid`)
    .all(worker)
    .map(sessionOf);
}

export function sessions(db: Database): readonly WorkerSession[] {
  return db.query<SessionRow, []>(`${SESSION} ORDER BY rowid`).all().map(sessionOf);
}

export function workerTokens(db: Database, worker: string): Tokens {
  const row = db
    .query<Tokens, [string, string]>(
      `SELECT coalesce(sum(u.input_tokens + u.cache_read_tokens + u.cache_write_tokens), 0) AS input,
              coalesce(sum(u.output_tokens), 0) AS output,
              coalesce(sum(u.cache_read_tokens), 0) AS cachedRead
       FROM usage u JOIN session s ON s.id = u.session_id
       WHERE s.id IN (SELECT id FROM worker_session WHERE worker = ?)
          OR s.parent_id IN (SELECT id FROM worker_session WHERE worker = ?)`,
    )
    .get(worker, worker);
  invariant(row !== null, "an aggregate returns one row");
  return row;
}

export function operatorOf(db: Database, project: string): Worker | null {
  const row = db.query<WorkerRow, [string]>(`${WORKER} WHERE role = 'operator' AND project = ?`).get(project);
  return row === null ? null : workerOf(row);
}
