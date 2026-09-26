import { openDb } from "./db";
import { dbPath, type Env } from "./paths";
import { type TraceEvent, writeTrace } from "./trace-store";

export function trace(record: TraceEvent, env: Env = process.env): void {
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb(dbPath(env), { busyTimeoutMs: 250 });
    writeTrace(db, record);
  } catch {
  } finally {
    db?.close();
  }
}
