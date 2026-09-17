import { closeDb, openDb } from "./db";
import { dbPath, type Env } from "./paths";

export type Trace = {
  command: string;
  name?: string;
  path?: string;
  rowCount?: number;
  durationMs?: number;
};

/**
 * Opened through `openDb` rather than a bare connection, because that is what
 * runs `SCHEMA_SQL`: a database written before this table existed would other-
 * wise take every insert as `no such table` and the catch below would hide it.
 *
 * Readers open read-only and a test holds that, so this is a second handle for
 * the write alone. A failure is dropped on purpose — the sync agent holds the
 * write lock every fifteen minutes, and a trace must never fail the command it
 * traces — which is a degradation chosen here, not an error left unhandled.
 */
export function trace(record: Trace, env: Env = process.env): void {
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb(dbPath(env));
    db.run("PRAGMA busy_timeout = 250");
    db.run(
      `INSERT INTO command_trace (ts, command, name, path, row_count, duration_ms, cwd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        record.command,
        record.name ?? null,
        record.path ?? null,
        record.rowCount ?? null,
        record.durationMs ?? null,
        process.cwd(),
      ],
    );
  } catch {
    // the degradation the docblock states
  } finally {
    if (db) closeDb(db);
  }
}
