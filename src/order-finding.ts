import type { Database } from "bun:sqlite";
import {
  findingStanding,
  type OrderFindingAnswer,
  type OwnerRuling,
  owesAnswer,
  type ReviewerRuling,
  rulingApplies,
} from "./order-finding-state";
import { appendOrderEventInTransaction } from "./order-ledger";
import { openReviewOf, ReviewNotOpen, releaseReviewApprovalInTransaction } from "./order-review";
import { assertOrderWorking } from "./order-status";
import type { ReviewFinding } from "./station-review-artifact";

const now = (): string => new Date().toISOString();

export class BuildTurnRefused extends Error {
  constructor(
    readonly code:
      | "no_declared_check"
      | "empty_artifact"
      | "builder_committed"
      | "nested_repository"
      | "check_failed"
      | "check_changed_tree"
      | "no_change"
      | "order_not_building"
      | "commit_refused"
      | "comment_added"
      | "rebase_in_progress"
      | "rebase_mismatch"
      | "conflict_unresolved"
      | "worker_not_builder"
      | "finding_unknown"
      | "finding_unanswered"
      | "answer_not_owed"
      | "refusal_overturned",
    message: string,
  ) {
    super(message);
  }
}

export function raiseOrderFinding(
  db: Database,
  orderId: string,
  finding: ReviewFinding,
  worker: string,
  at = now(),
): number {
  const row = openReviewOf(db, orderId);
  if (!row) {
    throw new ReviewNotOpen(
      "review_unknown",
      `order ${orderId} has no review open, and a finding belongs to the reading that raised it`,
    );
  }
  if (row.reviewer !== worker) {
    throw new ReviewNotOpen(
      "review_not_its_reviewer",
      `review ${row.id} was opened for ${row.reviewer}, and a finding is worth only what the hand ` +
        `that read the diff is worth; ${worker} did not read it`,
    );
  }
  assertOrderWorking(db, orderId);
  return db.transaction(() => {
    const result = db.run(
      `INSERT INTO factory_order_finding
         (review_id, dimension, file, line, failure, fix, severity, raised_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        finding.dimension,
        finding.file,
        finding.line,
        finding.failure,
        finding.fix,
        finding.severity,
        at,
      ],
    );
    const id = Number(result.lastInsertRowid);
    appendOrderEventInTransaction(db, orderId, { kind: "finding_raised", worker, findingId: id }, at);
    return id;
  })();
}

export function assertFindingAnswersOwed(
  db: Database,
  orderId: string,
  answers: readonly OrderFindingAnswer[],
): void {
  for (const given of answers) {
    const finding = findingStanding(db, given.finding);
    if (finding?.orderId !== orderId) {
      throw new BuildTurnRefused("finding_unknown", `order ${orderId} has no finding ${given.finding}`);
    }
    if (!owesAnswer(finding)) {
      throw new BuildTurnRefused(
        "answer_not_owed",
        finding.state === "open"
          ? `finding ${given.finding} is answered ${finding.answer}, and that answer waits on a ruling`
          : `finding ${given.finding} is ${finding.state}`,
      );
    }
    if (given.answer === "refused" && finding.ownerRuling === "refusal_overturned") {
      throw new BuildTurnRefused(
        "refusal_overturned",
        `the owner overturned the refusal of finding ${given.finding}, so it is answered fixed`,
      );
    }
  }
}

export function answerOrderFindings(
  db: Database,
  orderId: string,
  runId: string,
  answers: readonly OrderFindingAnswer[],
  worker: string,
  at = now(),
): void {
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(worker)?.role;
  if (role !== "builder") {
    throw new BuildTurnRefused("worker_not_builder", `worker ${worker} is not a builder`);
  }
  assertOrderWorking(db, orderId);
  db.transaction(() => {
    assertFindingAnswersOwed(db, orderId, answers);
    for (const given of answers) {
      const answer = db.run(
        `INSERT INTO factory_order_finding_answer (finding_id, run_id, answer, resolution, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
        [given.finding, runId, given.answer, given.resolution, at],
      );
      appendOrderEventInTransaction(
        db,
        orderId,
        {
          kind: "finding_answered",
          worker,
          findingId: given.finding,
          answerId: Number(answer.lastInsertRowid),
        },
        at,
      );
    }
  })();
}

export class FindingRulingRefused extends Error {
  constructor(
    readonly code:
      | "finding_unknown"
      | "finding_same_round"
      | "finding_not_open"
      | "ruling_repeated"
      | "ruling_not_applicable"
      | "reason_missing",
    message: string,
  ) {
    super(message);
  }
}

export function ruleOnOrderFinding(
  db: Database,
  findingId: number,
  ruling: { ruling: ReviewerRuling; reason?: string },
  worker: string,
  at = now(),
): number {
  const finding = findingStanding(db, findingId);
  if (!finding) throw new FindingRulingRefused("finding_unknown", `no finding ${findingId}`);
  const { orderId } = finding;
  const review = openReviewOf(db, orderId);
  if (!review) {
    throw new ReviewNotOpen("review_unknown", `order ${orderId} has no review open to rule in`);
  }
  if (review.reviewer !== worker) {
    throw new ReviewNotOpen(
      "review_not_its_reviewer",
      `review ${review.id} was opened for ${review.reviewer}, not ${worker}`,
    );
  }
  if (finding.reviewId === review.id) {
    throw new FindingRulingRefused(
      "finding_same_round",
      `finding ${findingId} was raised in review ${review.id}; a round rules only on earlier findings`,
    );
  }
  if (finding.state !== "open") {
    throw new FindingRulingRefused("finding_not_open", `finding ${findingId} is ${finding.state}`);
  }
  const ruled = db
    .query("SELECT 1 FROM factory_order_finding_ruling WHERE finding_id = ? AND review_id = ?")
    .get(findingId, review.id);
  if (ruled) {
    throw new FindingRulingRefused(
      "ruling_repeated",
      `finding ${findingId} already has a ruling from review ${review.id}`,
    );
  }
  if (!finding.answered) {
    throw new FindingRulingRefused(
      "ruling_not_applicable",
      `finding ${findingId} has no answer since its last ruling, and a ruling judges the builder's answer`,
    );
  }
  if (!rulingApplies(finding, ruling.ruling)) {
    throw new FindingRulingRefused(
      "ruling_not_applicable",
      finding.refusalStands
        ? `finding ${findingId} is a standing refusal, so it takes refusal_accepted or refusal_contested`
        : `finding ${findingId} is answered ${finding.answer}, so it takes addressed or not_addressed`,
    );
  }
  const needsReason = ruling.ruling === "not_addressed" || ruling.ruling === "refusal_contested";
  if (needsReason && !ruling.reason?.trim()) {
    throw new FindingRulingRefused(
      "reason_missing",
      `ruling ${ruling.ruling} on finding ${findingId} needs a reason`,
    );
  }
  assertOrderWorking(db, orderId);
  return db.transaction(() => {
    db.run(
      `INSERT INTO factory_order_finding_ruling (finding_id, review_id, ruling, reason, worker, ruled_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [findingId, review.id, ruling.ruling, ruling.reason ?? null, worker, at],
    );
    return appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "finding_ruled", worker, findingId, reviewId: review.id, evidence: { ruling: ruling.ruling } },
      at,
    );
  })();
}

export class OwnerRulingRefused extends Error {
  constructor(
    readonly code:
      | "worker_not_operator"
      | "finding_unknown"
      | "finding_not_awaiting_owner"
      | "reason_missing",
    message: string,
  ) {
    super(message);
  }
}

export function recordOwnerRuling(
  db: Database,
  findingId: number,
  ruling: { ruling: OwnerRuling; reason: string },
  worker: string,
  at = now(),
): number {
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(worker)?.role;
  if (role !== "operator") {
    throw new OwnerRulingRefused("worker_not_operator", `worker ${worker} is not an operator`);
  }
  const finding = findingStanding(db, findingId);
  if (!finding) throw new OwnerRulingRefused("finding_unknown", `no finding ${findingId}`);
  if (finding.state !== "awaiting_owner") {
    throw new OwnerRulingRefused(
      "finding_not_awaiting_owner",
      `finding ${findingId} is ${finding.state}, and only a contested refusal waits on the owner`,
    );
  }
  if (!ruling.reason.trim()) {
    throw new OwnerRulingRefused("reason_missing", `a ruling on finding ${findingId} needs a reason`);
  }
  const { orderId } = finding;
  assertOrderWorking(db, orderId);
  return db.transaction(() => {
    db.run(
      `INSERT INTO factory_order_finding_ruling (finding_id, review_id, ruling, reason, worker, ruled_at)
       VALUES (?, NULL, ?, ?, ?, ?)`,
      [findingId, ruling.ruling, ruling.reason, worker, at],
    );
    const event = appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "refusal_decided", worker, findingId, evidence: { ruling: ruling.ruling } },
      at,
    );
    if (ruling.ruling === "refusal_overturned") releaseReviewApprovalInTransaction(db, orderId, worker, at);
    return event;
  })();
}
