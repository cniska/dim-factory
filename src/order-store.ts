import type { Database } from "bun:sqlite";
import { invariant, unreachable } from "./assert";
import { type Actor, Detailed, type LogEntry } from "./order-contract";

export const ORDER_SQL = `
CREATE TABLE IF NOT EXISTS order_log (
  order_id        TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  at              TEXT NOT NULL,
  worker          TEXT,
  session         TEXT,
  factory_version TEXT,
  cause           INTEGER,
  action          TEXT NOT NULL,
  details         TEXT NOT NULL,
  PRIMARY KEY (order_id, seq),
  FOREIGN KEY (order_id, cause) REFERENCES order_log(order_id, seq),
  CHECK ((worker IS NOT NULL AND session IS NOT NULL AND factory_version IS NULL AND cause IS NULL)
      OR (worker IS NULL AND session IS NULL AND factory_version IS NOT NULL AND cause IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS order_log_no_update BEFORE UPDATE ON order_log
BEGIN SELECT RAISE(ABORT, 'order_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS order_log_no_delete BEFORE DELETE ON order_log
BEGIN SELECT RAISE(ABORT, 'order_log is append-only'); END;
`;

type LogRow = {
  readonly seq: number;
  readonly at: string;
  readonly worker: string | null;
  readonly session: string | null;
  readonly factory_version: string | null;
  readonly cause: number | null;
  readonly details: string;
};

function actorOf(row: LogRow): Actor {
  if (row.worker !== null) {
    invariant(row.session !== null, `order_log row ${row.seq} names its worker's session`);
    return { kind: "worker", worker: row.worker, session: row.session };
  }
  invariant(
    row.factory_version !== null && row.cause !== null,
    `order_log row ${row.seq} names the factory's version and cause`,
  );
  return { kind: "factory", version: row.factory_version, cause: row.cause };
}

function actorColumns(by: Actor): readonly [string | null, string | null, string | null, number | null] {
  switch (by.kind) {
    case "worker":
      return [by.worker, by.session, null, null];
    case "factory":
      return [null, null, by.version, by.cause];
    default:
      return unreachable(by);
  }
}

export function appendEntries(db: Database, orderId: string, entries: readonly LogEntry[]): void {
  const insert = db.prepare(
    `INSERT INTO order_log (order_id, seq, at, worker, session, factory_version, cause, action, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const { seq, at, by, ...detailed } of entries) {
    insert.run(orderId, seq, at, ...actorColumns(by), detailed.action, JSON.stringify(detailed));
  }
}

export function readLog(db: Database, orderId: string): readonly LogEntry[] {
  return db
    .query<LogRow, [string]>(
      `SELECT seq, at, worker, session, factory_version, cause, details
       FROM order_log WHERE order_id = ? ORDER BY seq`,
    )
    .all(orderId)
    .map((row) => ({
      seq: row.seq,
      at: row.at,
      by: actorOf(row),
      ...Detailed.parse(JSON.parse(row.details)),
    }));
}
