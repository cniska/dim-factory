import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { Env } from "./paths";
import { pidIsAlive } from "./pid";
import { nextWorkerName, wordFor } from "./worker-name";

/** What the factory hands a worker, and the only thing it reads back to know who wrote. */
export const WORKER_NAME_VAR = "DIM_WORKER_NAME";
export const WORKER_TOKEN_VAR = "DIM_WORKER_TOKEN";

export const WORKER_ROLES = ["planner", "builder", "reviewer"] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

export function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

export type WorkerUnknownCode = "worker_missing" | "worker_unissued" | "worker_over";

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
export type MintedWorker = { name: string; token: string };

const now = (): string => new Date().toISOString();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issued in one transaction, because the name is drawn from a count: two runs reading
 * the same count would be handed the same name, and SQLite's write lock is what makes
 * the read and the insert one step.
 */
export function mintWorker(
  db: Database,
  worker: { role?: WorkerRole; pid?: number } = {},
  at = now(),
): MintedWorker {
  const token = randomBytes(16).toString("hex");
  return db.transaction(() => {
    const workers = (db.query<{ n: number }, []>("SELECT count(*) AS n FROM factory_worker").get()?.n ??
      0) as number;
    const word = wordFor(workers);
    const onWord = (db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM factory_worker WHERE name LIKE ?")
      .get(`${word}-%`)?.n ?? 0) as number;
    const name = nextWorkerName(workers, onWord);
    db.run("INSERT INTO factory_worker (name, role, token_digest, pid, started_at) VALUES (?, ?, ?, ?, ?)", [
      name,
      worker.role ?? null,
      digest(token),
      worker.pid ?? null,
      at,
    ]);
    return { name, token };
  })();
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
        "the factory hands a worker it starts. Issue one for this shell with `dim worker mint`.",
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
  return `export ${WORKER_NAME_VAR}=${minted.name}\nexport ${WORKER_TOKEN_VAR}=${minted.token}`;
}
