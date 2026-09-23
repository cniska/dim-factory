import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { Env } from "./paths";
import { pidIsAlive } from "./pid";
import type { Role } from "./roles";
import { randomWorkerName } from "./worker-name";

/** What the factory hands a worker, and the only thing it reads back to know who wrote. */
export const WORKER_NAME_VAR = "DIM_WORKER_NAME";
export const WORKER_TOKEN_VAR = "DIM_WORKER_TOKEN";
export const WORKER_SESSION_VAR = "DIM_SESSION_ID";

export type WorkerUnknownCode = "worker_missing" | "worker_unissued" | "worker_over";

export class WorkerSessionTaken extends Error {
  readonly code = "worker_session_taken";
}

/** Carries a code because a caller deciding which condition failed must not match on prose. */
export class WorkerUnknown extends Error {
  constructor(
    readonly code: WorkerUnknownCode,
    message: string,
  ) {
    super(message);
  }
}

/** The name is public and names the worker everywhere; the token is what proves it is that one. */
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

/**
 * Issued in one transaction, because the name is drawn from the names already held: two
 * runs reading the same set would be handed the same name, and SQLite's write lock is what
 * makes the read and the insert one step.
 */
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
        .query<{ name: string; ended_at: string | null }, [string]>(
          "SELECT name, ended_at FROM factory_worker WHERE name = ?",
        )
        .get(worker.parentWorker);
      if (!parent) throw new Error(`parent worker ${worker.parentWorker} does not exist`);
      if (parent.ended_at !== null) throw new Error(`parent worker ${worker.parentWorker} has ended`);
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

/** Rotates the capability for a live identity without registering another identity. */
export function renewWorkerToken(db: Database, name: string): MintedWorker {
  const token = randomBytes(16).toString("hex");
  const row = db
    .query<{ name: string; session_id: string; ended_at: string | null }, [string]>(
      "SELECT name, session_id, ended_at FROM factory_worker WHERE name = ?",
    )
    .get(name);
  if (!row) throw new WorkerUnknown("worker_unissued", `this factory issued no worker ${name}`);
  if (row.ended_at !== null)
    throw new WorkerUnknown("worker_over", `worker ${name} ended at ${row.ended_at}`);
  if (!row.session_id) throw new Error(`worker ${name} has no session id`);
  db.run("UPDATE factory_worker SET token_digest = ? WHERE name = ? AND ended_at IS NULL", [
    digest(token),
    name,
  ]);
  return { name: row.name, token, sessionId: row.session_id };
}

type WorkerRow = { name: string; token_digest: string; pid: number | null; ended_at: string | null };

/**
 * The worker a command is running as, read from the environment the factory started it
 * in. A name alone would prove nothing — the issued set is readable through `dim sql`,
 * so any worker could name another — and the token is what makes the name a claim only
 * its holder can make.
 *
 * A worker whose process has stopped answering is over whether or not anything wrote
 * that down, which is what keeps a killed worker's token from outliving it.
 */
export function resolveWorker(db: Database, env: Env = process.env): string {
  const name = env[WORKER_NAME_VAR];
  const token = env[WORKER_TOKEN_VAR];
  if (!name || !token) {
    throw new WorkerUnknown(
      "worker_missing",
      `nothing says which worker this is: ${WORKER_NAME_VAR} and ${WORKER_TOKEN_VAR} are what ` +
        "the factory hands a worker it starts. Register one for this shell with `dim worker register`.",
    );
  }
  const row = db
    .query<WorkerRow, [string]>("SELECT name, token_digest, pid, ended_at FROM factory_worker WHERE name = ?")
    .get(name);
  if (!row || row.token_digest !== digest(token)) {
    throw new WorkerUnknown("worker_unissued", `this factory issued no worker ${name}`);
  }
  if (row.ended_at !== null) {
    throw new WorkerUnknown("worker_over", `worker ${name} ended at ${row.ended_at}`);
  }
  if (row.pid !== null && !pidIsAlive(row.pid)) {
    throw new WorkerUnknown("worker_over", `worker ${name} ran as pid ${row.pid}, which is gone`);
  }
  return row.name;
}

/**
 * Whether a hand is still there to hold anything, which is what `resolveWorker` refuses on
 * and what an order's holder is read through. A worker never issued is over by the same
 * answer: nothing is holding what nothing can write as.
 */
export function workerIsOver(db: Database, name: string): boolean {
  const row = db
    .query<{ pid: number | null; ended_at: string | null }, [string]>(
      "SELECT pid, ended_at FROM factory_worker WHERE name = ?",
    )
    .get(name);
  if (!row) return true;
  return row.ended_at !== null || (row.pid !== null && !pidIsAlive(row.pid));
}

/** Ending twice is not an error: a worker that already stopped keeps the time it stopped at. */
export function endWorker(db: Database, name: string, at = now()): boolean {
  const done = db.run("UPDATE factory_worker SET ended_at = ? WHERE name = ? AND ended_at IS NULL", [
    at,
    name,
  ]);
  return done.changes === 1;
}

/** The two lines a shell evaluates to become the worker, which is how a person is one. */
export function workerExports(minted: MintedWorker): string {
  return (
    `export ${WORKER_SESSION_VAR}=${minted.sessionId}\n` +
    `export ${WORKER_NAME_VAR}=${minted.name}\nexport ${WORKER_TOKEN_VAR}=${minted.token}`
  );
}

export function newWorkerSession(prefix = "session"): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

export function sessionIdFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  return env[WORKER_SESSION_VAR] ?? env.CODEX_SESSION_ID ?? env.CLAUDE_SESSION_ID;
}
