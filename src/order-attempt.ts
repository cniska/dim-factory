import type { Database } from "bun:sqlite";
import { assertOperator } from "./factory-operator";
import type { AttemptOutcome } from "./order-events";
import { assertOrderActive, OrderNotDone } from "./order-status";
import type { Station } from "./station";
import { workerIsOver } from "./worker";
import type { Role } from "./worker-roles";

export type Attempt = {
  runId: string;
  worker: string;
  operatorWorker: string;
  station: Station;
  sessionId?: string;
  providerSessionId?: string;
  harness?: string;
  model?: string;
  tier?: string;
};

export type OpenAttempt = { runId: string; worker: string; role: Role; station: Station };

export function openAttempt(db: Database, orderId: string): OpenAttempt | null {
  return db
    .query<OpenAttempt, [string]>(
      `SELECT a.run_id AS runId, a.worker, w.role, a.station FROM factory_order_attempt a
       JOIN factory_worker w ON w.name = a.worker
       WHERE a.order_id = ? AND a.kind = 'started' AND NOT EXISTS (
         SELECT 1 FROM factory_order_attempt f
         WHERE f.order_id = a.order_id AND f.run_id = a.run_id AND f.kind = 'finished'
       )
       ORDER BY a.id DESC LIMIT 1`,
    )
    .get(orderId);
}

export function runningAttempt(db: Database, orderId: string): OpenAttempt | null {
  const open = openAttempt(db, orderId);
  return open && !workerIsOver(db, open.worker) ? open : null;
}

export function assertNoRunningAttempt(db: Database, orderId: string, act: string): void {
  const running = runningAttempt(db, orderId);
  if (running) {
    throw new OrderNotDone(
      "order_held_by_run",
      `order ${orderId} is being worked by ${running.worker} under ${running.runId}, so it cannot ${act}`,
    );
  }
}

export function finishStoppedAttempt(db: Database, orderId: string, at: string): void {
  const previous = openAttempt(db, orderId);
  if (previous && workerIsOver(db, previous.worker)) {
    finishAttempt(db, orderId, "failed", "worker stopped without finishing", at);
  }
}

export function startAttempt(db: Database, orderId: string, attempt: Attempt, at: string): void {
  db.transaction(() => {
    assertOrderActive(db, orderId);
    finishStoppedAttempt(db, orderId, at);
    assertNoRunningAttempt(db, orderId, "start another attempt");
    assertOperator(db, attempt.operatorWorker, "delegate an attempt");
    db.run(
      `INSERT INTO factory_order_attempt
         (order_id, run_id, worker, operator_worker, session_id, provider_session_id, station, harness, model, tier,
          started_at, recorded_at, kind, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', 'running')`,
      [
        orderId,
        attempt.runId,
        attempt.worker,
        attempt.operatorWorker,
        attempt.sessionId ?? null,
        attempt.providerSessionId ?? null,
        attempt.station,
        attempt.harness ?? null,
        attempt.model ?? null,
        attempt.tier ?? null,
        at,
        at,
      ],
    );
  })();
}

export function finishAttempt(
  db: Database,
  orderId: string,
  outcome: Exclude<AttemptOutcome, "running">,
  reason: string | undefined,
  at: string,
): void {
  const open = openAttempt(db, orderId);
  if (!open) return;
  db.run(
    `INSERT INTO factory_order_attempt
       (order_id, run_id, worker, operator_worker, session_id, provider_session_id, station, harness, model, tier,
        started_at, ended_at, recorded_at, kind, outcome, reason)
     SELECT order_id, run_id, worker, operator_worker, session_id, provider_session_id, station, harness, model, tier,
            started_at, ?, ?, 'finished', ?, ?
     FROM factory_order_attempt WHERE order_id = ? AND run_id = ? AND kind = 'started'`,
    [at, at, outcome, reason ?? null, orderId, open.runId],
  );
}
