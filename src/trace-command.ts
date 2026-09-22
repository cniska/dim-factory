import type { Database } from "bun:sqlite";
import { dbPath, type Env } from "./paths";
import { openReadOnly } from "./read-db";

const TERMINAL_STATUSES = new Set(["completed", "dropped"]);

type TraceRow = {
  id: number;
  ts: string;
  event: string;
  order_id: string | null;
  attempt_id: string | null;
  station: string | null;
  worker: string | null;
  session_id: string | null;
  command: string | null;
  name: string | null;
  path: string | null;
  row_count: number | null;
  duration_ms: number | null;
  cwd: string | null;
  fields: string;
};

function print(row: TraceRow, write: (line: string) => void): void {
  const {
    id,
    order_id: orderId,
    attempt_id: attemptId,
    session_id: sessionId,
    row_count: rowCount,
    duration_ms: durationMs,
    fields,
    ...rest
  } = row;
  write(
    JSON.stringify({
      ...rest,
      id,
      orderId,
      attemptId,
      sessionId,
      rowCount,
      durationMs,
      fields: JSON.parse(fields),
    }),
  );
}

function status(db: Database, orderId: string): string | null {
  return (
    db.query<{ status: string }, [string]>("SELECT status FROM factory_order WHERE id = ?").get(orderId)
      ?.status ?? null
  );
}

function read(db: Database, orderId: string, after: number): TraceRow[] {
  return db
    .query<TraceRow, [string, number]>("SELECT * FROM trace_event WHERE order_id = ? AND id > ? ORDER BY id")
    .all(orderId, after);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runTraceCommand(
  orderId: string | undefined,
  env: Env = process.env,
  write: (line: string) => void = console.log,
): Promise<void> {
  if (!orderId) throw new Error("usage: dim trace <order-id>");
  let lastId = 0;
  while (true) {
    const db = openReadOnly(dbPath(env));
    try {
      const currentStatus = status(db, orderId);
      if (currentStatus === null) throw new Error(`no order named ${orderId}`);
      for (const row of read(db, orderId, lastId)) {
        lastId = row.id;
        print(row, write);
      }
      if (TERMINAL_STATUSES.has(currentStatus)) return;
    } finally {
      db.close();
    }
    await wait(100);
  }
}
