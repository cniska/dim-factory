import type { Database } from "bun:sqlite";

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

export function writeTrace(db: Database, record: TraceEvent, at = new Date().toISOString()): void {
  try {
    db.run(
      `INSERT INTO trace_event
       (ts, event, order_id, attempt_id, station, worker, session_id, command, name, path, row_count, duration_ms, cwd, fields)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        at,
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
  } catch {}
}
