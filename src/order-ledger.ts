import type { Database } from "bun:sqlite";
import { assertNoRunningAttempt, finishAttempt, openAttempt } from "./order-attempt";
import type { OrderEventKind } from "./order-events";
import { isTerminalOrderStatus, type OrderEvent, orderStatus } from "./order-status";
import { writeTrace } from "./trace-store";

export const now = (): string => new Date().toISOString();

const BEFORE_START: readonly OrderEventKind[] = ["queued", "started", "priority_changed", "dropped"];

function eventValues(orderId: string, event: OrderEvent, ts: string): (string | number | null)[] {
  return [
    orderId,
    ts,
    event.kind,
    event.worker ?? null,
    event.sessionId ?? null,
    event.station ?? null,
    event.commitSha ?? null,
    event.checkId ?? null,
    event.reviewId ?? null,
    event.findingId ?? null,
    event.answerId ?? null,
    event.artifactId ?? null,
    event.reason ?? null,
    JSON.stringify(event.evidence ?? {}),
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
  return db.transaction(() => appendOrderEventInTransaction(db, orderId, event, at))();
}

export function appendOrderEventInTransaction(
  db: Database,
  orderId: string,
  event: OrderEvent,
  at: string,
): number {
  const status = orderStatus(db, orderId);
  if (!event.worker && event.kind !== "failed") {
    throw new Error(`order ${orderId} ${event.kind} requires a worker`);
  }
  if (isTerminalOrderStatus(status)) throw new Error(`order ${orderId} is already ${status}`);
  if (event.kind === "dropped") assertNoRunningAttempt(db, orderId, "be dropped");
  if (!BEFORE_START.includes(event.kind) && status !== "running") {
    throw new Error(`order ${orderId} is ${status}, so it cannot record ${event.kind}`);
  }

  const ts = event.ts ?? at;
  const written = db.run(
    `INSERT INTO factory_order_event
       (order_id, ts, kind, worker, session_id, station, commit_sha, check_id, review_id, finding_id,
        answer_id, artifact_id, reason, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventValues(orderId, event, ts),
  );
  db.run("UPDATE factory_order SET updated_at = ? WHERE id = ?", [ts, orderId]);
  if (event.kind === "failed" && event.worker && openAttempt(db, orderId)?.worker === event.worker) {
    finishAttempt(db, orderId, "failed", event.reason, ts);
  }
  writeTrace(
    db,
    {
      event: "order.lifecycle",
      orderId,
      station: event.station,
      worker: event.worker,
      sessionId: event.sessionId,
      fields: {
        kind: event.kind,
        status: orderStatus(db, orderId),
        reason: event.reason ?? null,
        artifact: artifactKind(db, event.artifactId),
      },
    },
    ts,
  );
  return Number(written.lastInsertRowid);
}
