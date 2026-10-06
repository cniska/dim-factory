import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { invariant } from "./assert";
import { refuseRecord } from "./db-contract";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";
import { notifyWall } from "./wall-notify";

export function recordVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  invariant(row !== null, "PRAGMA user_version returns one row");
  return row.user_version;
}

function isFresh(db: Database): boolean {
  return (
    recordVersion(db) === 0 &&
    db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master").get()?.n === 0
  );
}

export function refuseOtherVersion(db: Database): void {
  const found = recordVersion(db);
  if (found !== SCHEMA_VERSION) throw refuseRecord("record_version", { found, expected: SCHEMA_VERSION });
}

const CONCURRENT_WRITER_WAIT_MS = 5000;

export function openDb(path: string, opts: { forRebuild?: boolean; busyTimeoutMs?: number } = {}): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.run(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? CONCURRENT_WRITER_WAIT_MS}`);
    const fresh = isFresh(db);
    if (!fresh && !opts.forRebuild) refuseOtherVersion(db);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    if (fresh) {
      writeTransaction(db, () => {
        if (!isFresh(db)) return;
        db.run(SCHEMA_SQL);
        db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
    if (opts.forRebuild) return db;
    refuseOtherVersion(db);
    db.run(SCHEMA_SQL);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function writeTransaction<T>(db: Database, fn: () => T): T {
  const result = db.transaction(fn).immediate();
  if (!db.inTransaction) notifyWall(db.filename);
  return result;
}

export function withDb<T>(path: string, use: (db: Database) => T, opts: { forRebuild?: boolean } = {}): T {
  const db = openDb(path, opts);
  try {
    return use(db);
  } finally {
    db.close();
  }
}
