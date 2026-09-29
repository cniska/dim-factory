import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { assertNoRunningAttempt, finishAttempt, openAttempt } from "./order-attempt";
import type { OrderEvent, OrderEventColumns } from "./order-contract";
import type { OrderEventKind } from "./order-events";
import { isTerminalOrderStatus, orderStatus } from "./order-status";
import { writeTrace } from "./trace-store";

export const now = (): string => new Date().toISOString();

const BEFORE_START: readonly OrderEventKind[] = ["queued", "started", "dropped"];

function eventValues(orderId: string, event: OrderEvent, ts: string): (string | number | null)[] {
  const columns: OrderEventColumns = event;
  return [
    orderId,
    ts,
    event.kind,
    columns.worker ?? null,
    columns.sessionId ?? null,
    columns.station ?? null,
    columns.commitSha ?? null,
    columns.findingId ?? null,
    columns.answerId ?? null,
    columns.artifactId ?? null,
    columns.reason ?? null,
  ];
}

function artifactKind(db: Database, artifactId: number | undefined): string | null {
  if (artifactId === undefined) return null;
  return (
    db
      .query<{ kind: string }, [number]>("SELECT kind FROM factory_order_artifact WHERE id = ?")
      .get(artifactId)?.kind ?? null
  );
}

export function appendOrderEvent(db: Database, orderId: string, event: OrderEvent, at = now()): number {
  return writeTransaction(db, () => appendOrderEventInTransaction(db, orderId, event, at));
}

export function appendOrderEventInTransaction(
  db: Database,
  orderId: string,
  event: OrderEvent,
  at: string,
): number {
  const status = orderStatus(db, orderId);
  if (isTerminalOrderStatus(status)) throw new Error(`order ${orderId} is already ${status}`);
  if (event.kind === "dropped") assertNoRunningAttempt(db, orderId, "be dropped");
  if (!BEFORE_START.includes(event.kind) && status !== "running") {
    throw new Error(`order ${orderId} is ${status}, so it cannot record ${event.kind}`);
  }

  const ts = event.ts ?? at;
  const written = db.run(
    `INSERT INTO factory_order_event
       (order_id, ts, kind, worker, session_id, station, commit_sha, finding_id,
        answer_id, artifact_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventValues(orderId, event, ts),
  );
  db.run("UPDATE factory_order SET updated_at = ? WHERE id = ?", [ts, orderId]);
  if (event.kind === "failed" && event.worker && openAttempt(db, orderId)?.worker === event.worker) {
    finishAttempt(db, orderId, "failed", event.reason, ts);
  }
  const columns: OrderEventColumns = event;
  writeTrace(
    db,
    {
      event: "order.lifecycle",
      orderId,
      station: columns.station,
      worker: columns.worker,
      sessionId: columns.sessionId,
      fields: {
        kind: event.kind,
        status: orderStatus(db, orderId),
        reason: columns.reason ?? null,
        artifact: artifactKind(db, columns.artifactId),
      },
    },
    ts,
  );
  return Number(written.lastInsertRowid);
}
