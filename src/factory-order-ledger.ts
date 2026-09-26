import type { Database } from "bun:sqlite";
import type { AttemptOutcome } from "./factory-events";
import { currentOrderCommits } from "./factory-order-commits";
import {
  APPROVAL_HOLD,
  assertDroppable,
  isTerminalOrderStatus,
  type OrderEvent,
  OrderNotDone,
  type OrderStatus,
} from "./factory-order-status";
import { writeTrace } from "./trace-store";
import { reachesTrunk } from "./trunk";

export const now = (): string => new Date().toISOString();

const VERB_FOR_KIND: Record<string, string> = { completed: "complete", moved: "move" };

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
    event.planId ?? null,
    event.buildId ?? null,
    event.holdType ?? null,
    event.status ?? null,
    event.reason ?? null,
    JSON.stringify(event.evidence ?? {}),
  ];
}

export function recordAttemptFinish(
  db: Database,
  orderId: string,
  runId: string | null,
  worker: string | undefined,
  station: string | null,
  outcome: Exclude<AttemptOutcome, "running">,
  reason: string | undefined,
  at: string,
): void {
  if (!runId || !worker) return;
  const started = db
    .query<
      {
        operator_worker: string | null;
        session_id: string | null;
        provider_session_id: string | null;
        harness: string | null;
        model: string | null;
        tier: string | null;
        started_at: string | null;
      },
      [string, string]
    >(
      `SELECT operator_worker, session_id, provider_session_id, harness, model, tier, started_at
       FROM factory_order_attempt
       WHERE order_id = ? AND run_id = ? AND kind = 'started'
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(orderId, runId);
  db.run(
    `INSERT INTO factory_order_attempt
       (order_id, run_id, worker, operator_worker, session_id, provider_session_id, station, harness, model, tier,
        started_at, ended_at, recorded_at, kind, outcome, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finished', ?, ?)`,
    [
      orderId,
      runId,
      worker,
      started?.operator_worker ?? null,
      started?.session_id ?? null,
      started?.provider_session_id ?? null,
      station,
      started?.harness ?? null,
      started?.model ?? null,
      started?.tier ?? null,
      started?.started_at ?? at,
      at,
      at,
      outcome,
      reason ?? null,
    ],
  );
}

export function setOrderHoldInTransaction(db: Database, orderId: string, hold: string | null, at: string) {
  return db.run("UPDATE factory_order SET hold = ?, updated_at = ? WHERE id = ?", [hold, at, orderId]);
}

export function recordOwnerVerdictInTransaction(
  db: Database,
  orderId: string,
  decision: "approved" | "returned" | "held" | "dropped",
  grounds: string,
  worker: string,
  at: string,
): number {
  if (grounds.trim() === "") throw new Error("owner verdict grounds must not be empty");
  const sessionId = db
    .query<{ session_id: string | null }, [string]>("SELECT session_id FROM factory_worker WHERE name = ?")
    .get(worker)?.session_id;
  const written = db.run(
    `INSERT INTO factory_order_verdict
       (order_id, decision, grounds, worker, session_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [orderId, decision, grounds, worker, sessionId ?? null, at],
  );
  const id = Number(written.lastInsertRowid);
  appendOrderEventInTransaction(
    db,
    orderId,
    { kind: "owner_verdict_recorded", worker, evidence: { decision, verdictId: id, grounds } },
    at,
  );
  return id;
}

export function appendOrderEvent(
  db: Database,
  orderId: string,
  event: OrderEvent,
  at = now(),
  worktree = process.cwd(),
): number {
  return db.transaction(() => appendOrderEventInTransaction(db, orderId, event, at, worktree))();
}

export function appendOrderEventInTransaction(
  db: Database,
  orderId: string,
  event: OrderEvent,
  at: string,
  worktree = process.cwd(),
  allowQueuedApprovalArtifactReturn = false,
): number {
  if (isTerminalOrderStatus(event.kind as OrderStatus) && event.status !== event.kind) {
    throw new Error(`terminal event kind must match its status: ${event.kind}`);
  }
  if (event.status && isTerminalOrderStatus(event.status) && event.kind !== event.status) {
    throw new Error(`terminal event status must match its kind: ${event.status}`);
  }
  const order = db
    .query("SELECT status, run_id, station, hold FROM factory_order WHERE id = ?")
    .get(orderId) as {
    status: OrderStatus;
    run_id: string | null;
    station: string | null;
    hold: string | null;
  } | null;
  if (!order) throw new Error(`order not found: ${orderId}`);
  if (!event.worker && event.kind !== "failed") {
    throw new Error(`order ${orderId} ${event.kind} requires a worker`);
  }
  if (isTerminalOrderStatus(order.status)) {
    throw new Error(`order ${orderId} is already ${order.status}`);
  }
  const returningHeldArtifact =
    allowQueuedApprovalArtifactReturn &&
    event.kind === "artifact_returned" &&
    order.status === "queued" &&
    order.hold === APPROVAL_HOLD;
  if (event.kind === "dropped") {
    assertDroppable(db, orderId);
  } else if (
    event.kind !== "queued" &&
    event.kind !== "claimed" &&
    event.kind !== "recovered" &&
    event.kind !== "provenance_recorded" &&
    event.kind !== "priority_changed" &&
    event.kind !== "hold_set" &&
    event.kind !== "hold_released" &&
    event.kind !== "owner_verdict_recorded"
  ) {
    if (order.status !== "working" && !returningHeldArtifact) {
      const action = VERB_FOR_KIND[event.kind] ?? event.kind;
      throw new Error(`order ${orderId} must be working before it can ${action}`);
    }
    if (event.kind === "completed") {
      assertChecked(db, orderId);
      assertIntegrated(db, orderId, worktree);
    }
  }

  const written = db.run(
    `INSERT INTO factory_order_event
       (order_id, ts, kind, worker, session_id, station, commit_sha, check_id, review_id, finding_id,
        answer_id, plan_id, build_id, hold_type, status, reason, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventValues(orderId, event, event.ts ?? at),
  );
  const projected = event.kind === "failed" ? "queued" : (event.status ?? null);
  db.run(
    `UPDATE factory_order SET status = coalesce(?, status), updated_at = ?,
       completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
       stop_reason = coalesce(?, stop_reason),
       run_id = CASE WHEN ? = 'failed' THEN NULL ELSE run_id END,
       claimed_at = CASE WHEN ? = 'failed' THEN NULL ELSE claimed_at END
       WHERE id = ?`,
    [
      projected,
      event.ts ?? at,
      projected,
      event.ts ?? at,
      event.reason ?? null,
      event.kind,
      event.kind,
      orderId,
    ],
  );
  if (event.kind === "failed") {
    recordAttemptFinish(
      db,
      orderId,
      order.run_id,
      event.worker,
      order.station,
      "failed",
      event.reason,
      event.ts ?? at,
    );
  } else if (event.kind === "completed") {
    recordAttemptFinish(
      db,
      orderId,
      order.run_id,
      event.worker,
      order.station,
      "succeeded",
      undefined,
      event.ts ?? at,
    );
  }
  writeTrace(
    db,
    {
      event: "order.lifecycle",
      orderId,
      station: event.station ?? order.station ?? undefined,
      worker: event.worker,
      sessionId: event.sessionId,
      fields: {
        kind: event.kind,
        status: event.status ?? projected,
        reason: event.reason ?? null,
      },
    },
    event.ts ?? at,
  );
  return Number(written.lastInsertRowid);
}

export function assertChecked(db: Database, orderId: string): void {
  const passed = db
    .query(
      `SELECT 1 FROM factory_order_check c
       JOIN factory_order_event check_event
         ON check_event.order_id = c.order_id AND check_event.check_id = c.id AND check_event.kind = 'check_finished'
       WHERE c.order_id = ? AND c.exit_code = 0
         AND check_event.id > coalesce((
           SELECT max(commit_event.id) FROM factory_order_event commit_event
           WHERE commit_event.order_id = c.order_id AND commit_event.kind = 'commit_created'
         ), 0)
       LIMIT 1`,
    )
    .get(orderId);
  if (!passed) {
    throw new OrderNotDone(
      "order_not_checked",
      `order ${orderId} cannot complete without a check that passed after its last commit: ` +
        `record one with \`dim order check ${orderId} --command "..." --exit 0\`, ` +
        "or stop it as failed.",
    );
  }
}

function assertIntegrated(db: Database, orderId: string, worktree: string): void {
  const shas = currentOrderCommits(db, orderId).map((row) => row.sha);
  if (shas.length === 0) {
    throw new OrderNotDone(
      "order_not_integrated",
      `order ${orderId} recorded no commit, so nothing of it is on the trunk: ` +
        `record what it landed with \`dim order commit ${orderId} --sha <sha>\`, ` +
        "or stop it as failed.",
    );
  }
  const reach = shas.map((sha) => reachesTrunk(worktree, sha));
  if (reach.some((one) => one.reach === "reached")) return;
  const unknown = reach.find((one) => one.reach === "unknown");
  if (unknown && unknown.reach === "unknown") {
    throw new OrderNotDone(
      "order_trunk_unknown",
      `order ${orderId} cannot be placed against a trunk, so nothing can say whether it is ` +
        `integrated: ${unknown.why}.`,
    );
  }
  if (reach.every((one) => one.reach === "absent")) {
    throw new OrderNotDone(
      "order_not_integrated",
      `order ${orderId} recorded commits that ${worktree} does not have, so nothing there can place ` +
        `them: check the shas recorded with \`dim q order ${orderId}\`.`,
    );
  }
  throw new OrderNotDone(
    "order_not_integrated",
    `order ${orderId} has no recorded commit on the trunk: merge its branch before completing it, ` +
      "or stop it as failed.",
  );
}
