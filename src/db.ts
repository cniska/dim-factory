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
 * re-reading the sources is exactly the fix the error asks for. It stamps the
 * new version itself once that re-read has returned: stamped here, a re-read
 * that threw would leave a database claiming a version its rows do not have,
 * and every later `sync` would pass the check and hit the same failure.
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
