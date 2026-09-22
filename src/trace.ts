import { closeDb, openDb } from "./db";
import { dbPath, type Env } from "./paths";

export type TraceEvent = {
  event: string;
  orderId?: string;
  attemptId?: string;
  station?: string;
  worker?: string;
  sessionId?: string;
  command?: string;
  name?: string;
  path?: string;
  rowCount?: number;
  durationMs?: number;
  fields?: Record<string, string | number | boolean | null>;
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
export function trace(record: TraceEvent, env: Env = process.env): void {
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb(dbPath(env));
    db.run("PRAGMA busy_timeout = 250");
    db.run(
      `INSERT INTO trace_event
       (ts, event, order_id, attempt_id, station, worker, session_id, command, name, path, row_count, duration_ms, cwd, fields)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        record.event,
        record.orderId ?? null,
        record.attemptId ?? null,
        record.station ?? null,
        record.worker ?? null,
        record.sessionId ?? null,
        record.command ?? null,
        record.name ?? null,
        record.path ?? null,
        record.rowCount ?? null,
        record.durationMs ?? null,
        process.cwd(),
        JSON.stringify(record.fields ?? {}),
      ],
    );
  } catch {
    // the degradation the docblock states
  } finally {
    if (db) closeDb(db);
  }
}
