import { openDb } from "./db";
import { dbPath, type Env } from "./paths";
import { type TraceEvent, writeTrace } from "./trace-store";

const TRACE_BEST_EFFORT_WAIT_MS = 250;

export function trace(record: TraceEvent, env: Env = process.env): void {
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb(dbPath(env), { busyTimeoutMs: TRACE_BEST_EFFORT_WAIT_MS });
    writeTrace(db, record);
  } catch {
  } finally {
    db?.close();
  }
}
