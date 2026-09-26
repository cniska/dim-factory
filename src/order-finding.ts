import type { Database } from "bun:sqlite";
import { findingStanding, type OrderFindingAnswer, owesAnswer } from "./order-finding-state";
import { appendOrderEventInTransaction } from "./order-ledger";
import { openReviewOf, ReviewNotOpen } from "./order-review";
import { assertOrderActive } from "./order-status";
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
      | "commit_refused"
      | "comment_added"
      | "rebase_in_progress"
      | "rebase_mismatch"
      | "conflict_unresolved"
      | "worker_not_builder"
      | "finding_unknown"
      | "finding_unanswered"
      | "answer_not_owed",
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
  assertOrderActive(db, orderId);
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
      throw new BuildTurnRefused("answer_not_owed", `finding ${given.finding} is answered ${finding.answer}`);
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
  assertOrderActive(db, orderId);
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
