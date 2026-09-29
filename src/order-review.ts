import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { writeArtifactInTransaction } from "./order-artifacts";
import { fail } from "./order-contract";
import { now } from "./order-ledger";
import { assertOrderRunning } from "./order-status";
import { workerIsOver } from "./worker";

export function openOrderReview(
  db: Database,
  orderId: string,
  round: { assignmentId: string; baseSha: string; headSha: string },
  at = now(),
): { id: number; round: number } {
  assertOrderRunning(db, orderId);
  return writeTransaction(db, () => {
    const live = db
      .query<{ id: number }, [string]>(
        "SELECT id FROM factory_order_review WHERE order_id = ? AND closed_at IS NULL",
      )
      .get(orderId);
    if (live) throw fail("review_open", { orderId, reviewId: live.id });
    const next =
      (db
        .query<{ n: number }, [string]>(
          "SELECT coalesce(max(round), 0) AS n FROM factory_order_review WHERE order_id = ?",
        )
        .get(orderId)?.n as number) + 1;
    const written = db.run(
      `INSERT INTO factory_order_review
       (order_id, round, reviewer, assignment_id, base_sha, head_sha, opened_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      [orderId, next, round.assignmentId, round.baseSha, round.headSha, at],
    );
    return { id: Number(written.lastInsertRowid), round: next };
  });
}

export function closeOrderReview(
  db: Database,
  reviewId: number,
  outcome: "closed" | "aborted",
  at = now(),
): void {
  const row = db
    .query<{ closed_at: string | null }, [number]>("SELECT closed_at FROM factory_order_review WHERE id = ?")
    .get(reviewId);
  if (!row) throw fail("review_missing", { reviewId });
  if (row.closed_at !== null) {
    throw fail("review_closed", { reviewId });
  }
  db.run("UPDATE factory_order_review SET closed_at = ?, outcome = ? WHERE id = ?", [at, outcome, reviewId]);
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
  if (!review) throw fail("review_not_open", { orderId });
  if (review.reviewer !== worker) {
    throw fail("review_not_its_reviewer", { reviewId: review.id, reviewer: review.reviewer, worker });
  }
  assertOrderRunning(db, orderId);
  if (review.closed_at !== null) {
    throw fail("review_closed", { reviewId: review.id });
  }
  return writeTransaction(db, () =>
    writeArtifactInTransaction(
      db,
      orderId,
      { kind: "review", body, headSha: review.head_sha, reviewId: review.id },
      worker,
      at,
    ),
  );
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

export function abortStrandedReview(db: Database, orderId: string, at = now()): void {
  const left = openReviewOf(db, orderId);
  if (left && (!left.reviewer || workerIsOver(db, left.reviewer)))
    closeOrderReview(db, left.id, "aborted", at);
}
