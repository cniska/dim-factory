import type { Database } from "bun:sqlite";
import {
  approveArtifactInTransaction,
  assertReturnedArtifactRevised,
  holdForApprovalInTransaction,
  nextOrderSlice,
  returnedOrderArtifact,
  writeArtifactInTransaction,
} from "./factory-order-artifacts";
import { carriedThroughRewrites, latestOrderCommit } from "./factory-order-commits";
import { appendOrderEventInTransaction, now, setOrderHoldInTransaction } from "./factory-order-ledger";
import {
  APPROVAL_HOLD,
  assertOrderWorking,
  OrderNotDone,
  ReviewApprovalRefused,
} from "./factory-order-status";
import { orderFindingStandings } from "./order-finding-state";

function latestReview(
  db: Database,
  orderId: string,
): { id: number; outcome: string | null; headSha: string } | null {
  return db
    .query<{ id: number; outcome: string | null; headSha: string }, [string]>(
      "SELECT id, outcome, head_sha AS headSha FROM factory_order_review WHERE order_id = ? ORDER BY round DESC, id DESC LIMIT 1",
    )
    .get(orderId);
}

function reviewApproved(db: Database, reviewId: number): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM factory_order_event e
         JOIN factory_order_artifact a ON a.id = e.artifact_id
         WHERE e.kind = 'artifact_approved' AND a.review_id = ?`,
      )
      .get(reviewId) !== null
  );
}

export function assertReviewApproved(db: Database, orderId: string): void {
  const review = latestReview(db, orderId);
  if (!review) throw new OrderNotDone("review_not_approved", `order ${orderId} has no review to approve`);
  const commit = latestOrderCommit(db, orderId);
  if (!commit || commit.sha !== carriedThroughRewrites(db, orderId, review.headSha)) {
    throw new OrderNotDone(
      "review_not_approved",
      `order ${orderId} has a commit its approved review did not read, or a rebase since changed a patch`,
    );
  }
  if (!reviewApproved(db, review.id)) {
    throw new OrderNotDone(
      "review_not_approved",
      `review ${review.id} for order ${orderId} is not approved by the operator`,
    );
  }
}

export function releaseReviewApprovalInTransaction(
  db: Database,
  orderId: string,
  worker: string,
  at: string,
): void {
  const held = db
    .query<{ hold: string | null; station: string | null }, [string]>(
      "SELECT hold, station FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  const atReview = held?.station === "review" || held?.station === "dim-station-review";
  if (held?.hold !== APPROVAL_HOLD || !atReview) return;
  setOrderHoldInTransaction(db, orderId, null, at);
  appendOrderEventInTransaction(db, orderId, { kind: "hold_released", worker, evidence: { hold: null } }, at);
}

export type ReviewRound = { id: number; round: number; reviewer: string | null };

export class ReviewNotOpen extends Error {
  constructor(
    readonly code:
      | "review_open"
      | "review_unknown"
      | "review_closed"
      | "review_not_its_reviewer"
      | "review_running",
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
  assertOrderWorking(db, orderId);
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
  assertOrderWorking(db, orderId);
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
    const event = appendOrderEventInTransaction(
      db,
      row.order_id,
      { kind: "review_closed", worker, reviewId, reason },
      at,
    );
    const returnsWork = orderFindingStandings(db, row.order_id).some((finding) => finding.state === "open");
    if (outcome === "closed" && !returnsWork && nextOrderSlice(db, row.order_id) === null) {
      holdForApprovalInTransaction(db, row.order_id, worker, at);
    }
    return event;
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
  assertOrderWorking(db, orderId);
  const returned = returnedOrderArtifact(db, orderId, "review");
  if (review.closed_at !== null && returned?.reviewId !== review.id) {
    throw new ReviewNotOpen("review_closed", `review ${review.id} is closed`);
  }
  if (review.closed_at === null && returned) {
    throw new ReviewNotOpen(
      "review_open",
      `review ${review.id} already has a returned artifact revision in progress`,
    );
  }
  if (review.closed_at !== null) {
    const findings = db
      .query<{ n: number }, [number]>("SELECT count(*) AS n FROM factory_order_finding WHERE review_id = ?")
      .get(review.id)?.n;
    const outcome = db
      .query<{ outcome: string | null }, [number]>("SELECT outcome FROM factory_order_review WHERE id = ?")
      .get(review.id)?.outcome;
    if (outcome !== "closed" || findings) {
      throw new ReviewNotOpen("review_closed", `review ${review.id} is not a clean review`);
    }
  }
  return db.transaction(() => {
    const artifactId = writeArtifactInTransaction(
      db,
      orderId,
      { kind: "review", body, headSha: review.head_sha, reviewId: review.id },
      worker,
      at,
    );
    if (review.closed_at !== null) holdForApprovalInTransaction(db, orderId, worker, at);
    return artifactId;
  })();
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

export function approveOrderReview(db: Database, orderId: string, worker: string, at = now()): void {
  assertOrderWorking(db, orderId);
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(worker)?.role;
  if (role !== "operator")
    throw new ReviewApprovalRefused("worker_not_operator", `worker ${worker} is not an operator`);
  assertReturnedArtifactRevised(db, orderId, "review");
  const review = latestReview(db, orderId);
  if (!review) throw new ReviewApprovalRefused("review_missing", `order ${orderId} has no review to approve`);
  if (review.outcome === null)
    throw new ReviewApprovalRefused(
      "review_not_closed",
      `review ${review.id} for order ${orderId} is still open`,
    );
  if (review.outcome !== "closed")
    throw new ReviewApprovalRefused("review_aborted", `review ${review.id} for order ${orderId} was aborted`);
  const artifact = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM factory_order_artifact WHERE review_id = ? ORDER BY revision DESC LIMIT 1",
    )
    .get(review.id);
  if (!artifact) {
    throw new ReviewApprovalRefused(
      "review_artifact_missing",
      `review ${review.id} for order ${orderId} has no Review artifact`,
    );
  }
  const standings = orderFindingStandings(db, orderId);
  const open = standings.filter((finding) => finding.state === "open").map((finding) => finding.id);
  if (open.length > 0) {
    throw new ReviewApprovalRefused(
      "finding_unsettled",
      `order ${orderId} has open finding${open.length === 1 ? "" : "s"} ${open.join(", ")}`,
    );
  }
  const awaiting = standings
    .filter((finding) => finding.state === "awaiting_owner")
    .map((finding) => finding.id);
  if (awaiting.length > 0) {
    throw new ReviewApprovalRefused(
      "ruling_pending",
      `order ${orderId} holds contested refusal${awaiting.length === 1 ? "" : "s"} on finding${awaiting.length === 1 ? "" : "s"} ` +
        `${awaiting.join(", ")} for the owner: \`dim order rule <finding-id> --uphold|--overturn --reason "..."\``,
    );
  }
  if (reviewApproved(db, review.id))
    throw new ReviewApprovalRefused(
      "review_already_approved",
      `review ${review.id} for order ${orderId} is already approved`,
    );
  db.transaction(() => approveArtifactInTransaction(db, orderId, artifact.id, worker, undefined, at))();
}
