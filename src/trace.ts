import { openDb } from "./db";
import { dbPath, type Env } from "./paths";
import { type TraceEvent, writeTrace } from "./trace-store";

/**
 * Opened through `openDb` rather than a bare connection, because that is what
 * runs `SCHEMA_SQL`: a database written before this table existed would other-
 * wise take every insert as `no such table` and the catch below would hide it.
 *
 * Readers open read-only and a test holds that, so this is a second handle for
 * the write alone. A failure is dropped on purpose — the sync agent holds the
 * write lock every fifteen minutes, and a trace must never fail the command it
 * traces — which is a degradation chosen here, not an error left unhandled.
 * It closes without the checkpoint `closeDb` runs, which a read-only sandbox
 * refuses and which belongs to the writers that fill the WAL.
 */
export function trace(record: TraceEvent, env: Env = process.env): void {
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb(dbPath(env));
    db.run("PRAGMA busy_timeout = 250");
    writeTrace(db, record);
  } catch {
    // the degradation the docblock states
  } finally {
    db?.close();
  }
}
