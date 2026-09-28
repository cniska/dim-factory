import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";

export class SchemaTooOldError extends Error {
  readonly code = "SCHEMA_TOO_OLD";
  constructor(readonly found: number) {
    super(
      `database was built by schema version ${found}, this is version ${SCHEMA_VERSION}; run \`dim rebuild\``,
    );
  }
}

export function storedSchemaVersion(db: Database): number | null {
  const hasVersionTable = db
    .query<{ present: number }, []>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
    )
    .get();
  if (!hasVersionTable) return null;
  return (
    db.prepare<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1").get()?.version ?? null
  );
}

export function refuseOtherSchema(found: number | null): void {
  if (found !== null && found !== SCHEMA_VERSION) throw new SchemaTooOldError(found);
}

export function openDb(path: string, opts: { forRebuild?: boolean; busyTimeoutMs?: number } = {}): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  let transactionOpen = false;
  try {
    db.run(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
    const found = storedSchemaVersion(db);
    if (!opts.forRebuild) refuseOtherSchema(found);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    if (found === null) {
      db.run("BEGIN IMMEDIATE");
      transactionOpen = true;
    }
    db.run(SCHEMA_SQL);
    if (found === null) {
      const initialized = storedSchemaVersion(db);
      if (initialized === null) db.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
      else if (!opts.forRebuild) refuseOtherSchema(initialized);
      db.run("COMMIT");
      transactionOpen = false;
    }
    return db;
  } catch (error) {
    try {
      if (transactionOpen) db.run("ROLLBACK");
    } finally {
      db.close();
    }
    throw error;
  }
}

export function writeTransaction<T>(db: Database, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function closeDb(db: Database): void {
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

export function withDb<T>(path: string, use: (db: Database) => T, opts: { forRebuild?: boolean } = {}): T {
  const db = openDb(path, opts);
  try {
    return use(db);
  } finally {
    closeDb(db);
  }
}
