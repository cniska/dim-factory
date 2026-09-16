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

/**
 * `rebuild` is the one caller allowed through a version mismatch, because
 * re-reading the sources is exactly the fix the error asks for.
 */
export function openDb(path: string, opts: { forRebuild?: boolean } = {}): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(SCHEMA_SQL);

  const row = db.prepare<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1").get();
  if (!row) {
    db.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
  } else if (row.version !== SCHEMA_VERSION) {
    if (!opts.forRebuild) {
      db.close();
      throw new SchemaTooOldError(row.version);
    }
    db.run("UPDATE schema_version SET version = ?", [SCHEMA_VERSION]);
  }
  return db;
}

export function closeDb(db: Database): void {
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}
