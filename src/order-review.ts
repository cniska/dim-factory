import type { Database } from "bun:sqlite";
import { writeArtifactInTransaction } from "./order-artifacts";
import { appendOrderEventInTransaction, now } from "./order-ledger";
import { assertOrderActive } from "./order-status";
import { workerIsOver } from "./worker";

export type ReviewRound = { id: number; round: number; reviewer: string | null };

export class ReviewNotOpen extends Error {
  constructor(
    readonly code: "review_open" | "review_unknown" | "review_closed" | "review_not_its_reviewer",
    message: string,
  ) {
    super(message);
  }
}

export function openOrderReview(
  db: Database,
  orderId: string,
  round: { reviewer: string; baseSha: string; headSha: string },
  worker: string,
  at = now(),
): ReviewRound {
  assertOrderActive(db, orderId);
  return db.transaction(() => {
    const live = db
      .query<{ id: number }, [string]>(
        "SELECT id FROM factory_order_review WHERE order_id = ? AND closed_at IS NULL",
      )
      .get(orderId);
    if (live) {
      throw new ReviewNotOpen("review_open", `order ${orderId} already has review ${live.id} open`);
    }
    const last = (db
      .query<{ n: number }, [string]>(
        "SELECT coalesce(max(round), 0) AS n FROM factory_order_review WHERE order_id = ?",
      )
      .get(orderId)?.n ?? 0) as number;
    const next = last + 1;
    const written = db.run(
      `INSERT INTO factory_order_review (order_id, round, reviewer, base_sha, head_sha, opened_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, next, round.reviewer, round.baseSha, round.headSha, at],
    );
    const id = Number(written.lastInsertRowid);
    appendOrderEventInTransaction(db, orderId, { kind: "review_opened", worker, reviewId: id }, at);
    return { id, round: next, reviewer: round.reviewer };
  })();
}

export function openAssignedOrderReview(
  db: Database,
  orderId: string,
  round: { assignmentId: string; baseSha: string; headSha: string },
  worker: string,
  at = now(),
): ReviewRound {
  assertOrderActive(db, orderId);
  return db.transaction(() => {
    const live = db
      .query<{ id: number }, [string]>(
        "SELECT id FROM factory_order_review WHERE order_id = ? AND closed_at IS NULL",
      )
      .get(orderId);
    if (live) throw new ReviewNotOpen("review_open", `order ${orderId} already has review ${live.id} open`);
    const next =
      ((db
        .query<{ n: number }, [string]>(
          "SELECT coalesce(max(round), 0) AS n FROM factory_order_review WHERE order_id = ?",
        )
        .get(orderId)?.n ?? 0) as number) + 1;
    const written = db.run(
      `INSERT INTO factory_order_review
       (order_id, round, reviewer, assignment_id, base_sha, head_sha, opened_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      [orderId, next, round.assignmentId, round.baseSha, round.headSha, at],
    );
    const id = Number(written.lastInsertRowid);
    appendOrderEventInTransaction(db, orderId, { kind: "review_opened", worker, reviewId: id }, at);
    return { id, round: next, reviewer: null };
  })();
}

export function closeOrderReview(
  db: Database,
  reviewId: number,
  outcome: "closed" | "aborted",
  worker: string,
  at = now(),
  reason?: string,
): number {
  const row = db
    .query<{ order_id: string; closed_at: string | null }, [number]>(
      "SELECT order_id, closed_at FROM factory_order_review WHERE id = ?",
    )
    .get(reviewId);
  if (!row) throw new ReviewNotOpen("review_unknown", `no review ${reviewId}`);
  if (row.closed_at !== null) {
    throw new ReviewNotOpen("review_closed", `review ${reviewId} closed at ${row.closed_at}`);
  }
  return db.transaction(() => {
    db.run("UPDATE factory_order_review SET closed_at = ?, outcome = ? WHERE id = ?", [
      at,
      outcome,
      reviewId,
    ]);
    return appendOrderEventInTransaction(
      db,
      row.order_id,
      { kind: "review_closed", worker, reviewId, reason },
      at,
    );
  })();
}

export function recordOrderReviewArtifact(
  db: Database,
  orderId: string,
  body: string,
  worker: string,
  at = now(),
): number {
  if (body.trim() === "") throw new Error("Review artifact body must not be empty");
  const review = db
    .query<
      {
        id: number;
        reviewer: string | null;
        assignment_id: string | null;
        closed_at: string | null;
        head_sha: string;
      },
      [string]
    >(
      `SELECT r.id, coalesce(r.reviewer, a.accepted_worker) AS reviewer, r.assignment_id, r.closed_at, r.head_sha
       FROM factory_order_review r
       LEFT JOIN factory_worker_assignment a ON a.id = r.assignment_id
       WHERE r.order_id = ? ORDER BY r.round DESC LIMIT 1`,
    )
    .get(orderId);
  if (!review) throw new ReviewNotOpen("review_unknown", `order ${orderId} has no review for an artifact`);
  if (review.reviewer !== worker) {
    throw new ReviewNotOpen(
      "review_not_its_reviewer",
      `review ${review.id} belongs to ${review.reviewer}, not ${worker}`,
    );
  }
  assertOrderActive(db, orderId);
  if (review.closed_at !== null) {
    throw new ReviewNotOpen("review_closed", `review ${review.id} is closed`);
  }
  return db.transaction(() =>
    writeArtifactInTransaction(
      db,
      orderId,
      { kind: "review", body, headSha: review.head_sha, reviewId: review.id },
      worker,
      at,
    ),
  )();
}

export function openReviewOf(db: Database, orderId: string): { id: number; reviewer: string | null } | null {
  return db
    .query<{ id: number; reviewer: string | null }, [string]>(
      `SELECT r.id, coalesce(r.reviewer, a.accepted_worker) AS reviewer
       FROM factory_order_review r
       LEFT JOIN factory_worker_assignment a ON a.id = r.assignment_id
       WHERE r.order_id = ? AND r.closed_at IS NULL`,
    )
    .get(orderId);
}

export function abortStrandedReview(db: Database, orderId: string, worker: string, at = now()): void {
  const left = openReviewOf(db, orderId);
  if (left && (!left.reviewer || workerIsOver(db, left.reviewer))) {
    closeOrderReview(db, left.id, "aborted", worker, at, "its reviewer stopped without finishing");
  }
}
