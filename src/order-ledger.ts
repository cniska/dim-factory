import type { Database } from "bun:sqlite";
import { reachesTrunk } from "./git-trunk";
import { assertNoRunningAttempt, finishAttempt } from "./order-attempt";
import { currentOrderCommits } from "./order-commits";
import { isTerminalOrderStatus, type OrderEvent, OrderNotDone, type OrderStatus } from "./order-status";
import { writeTrace } from "./trace-store";

export const now = (): string => new Date().toISOString();

const VERB_FOR_KIND: Record<string, string> = { completed: "complete" };

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
    event.status ?? null,
    event.reason ?? null,
    JSON.stringify(event.evidence ?? {}),
  ];
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
): number {
  if (isTerminalOrderStatus(event.kind as OrderStatus) && event.status !== event.kind) {
    throw new Error(`terminal event kind must match its status: ${event.kind}`);
  }
  if (event.status && isTerminalOrderStatus(event.status) && event.kind !== event.status) {
    throw new Error(`terminal event status must match its kind: ${event.status}`);
  }
  const order = db.query("SELECT status FROM factory_order WHERE id = ?").get(orderId) as {
    status: OrderStatus;
  } | null;
  if (!order) throw new Error(`order not found: ${orderId}`);
  if (!event.worker && event.kind !== "failed") {
    throw new Error(`order ${orderId} ${event.kind} requires a worker`);
  }
  if (isTerminalOrderStatus(order.status)) {
    throw new Error(`order ${orderId} is already ${order.status}`);
  }
  if (event.kind === "dropped") {
    assertNoRunningAttempt(db, orderId, "be dropped");
  } else if (
    event.kind !== "queued" &&
    event.kind !== "started" &&
    event.kind !== "recovered" &&
    event.kind !== "provenance_recorded" &&
    event.kind !== "priority_changed"
  ) {
    if (order.status !== "working") {
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
        answer_id, artifact_id, status, reason, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventValues(orderId, event, event.ts ?? at),
  );
  const projected = event.status ?? null;
  db.run(
    `UPDATE factory_order SET status = coalesce(?, status), updated_at = ?,
       completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
       stop_reason = coalesce(?, stop_reason)
       WHERE id = ?`,
    [projected, event.ts ?? at, projected, event.ts ?? at, event.reason ?? null, orderId],
  );
  if (event.kind === "failed") {
    finishAttempt(db, orderId, "failed", event.reason, event.ts ?? at);
  } else if (event.kind === "completed") {
    finishAttempt(db, orderId, "succeeded", undefined, event.ts ?? at);
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
