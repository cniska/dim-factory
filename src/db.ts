import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

export class SchemaTooOldError extends Error {
  readonly code = "SCHEMA_TOO_OLD";
  constructor(readonly found: number) {
    super(
      `database was built by schema version ${found}, this is version ${SCHEMA_VERSION}; run \`dim rebuild\``,
    );
  }
}

export function openDb(path: string, opts: { forRebuild?: boolean; busyTimeoutMs?: number } = {}): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(SCHEMA_SQL);

  const row = db.prepare<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1").get();
  if (!row) {
    db.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
  } else if (row.version !== SCHEMA_VERSION && !opts.forRebuild) {
    db.close();
    throw new SchemaTooOldError(row.version);
  }
  return db;
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
