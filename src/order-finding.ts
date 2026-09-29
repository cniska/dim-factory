import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { fail } from "./order-contract";
import { findingStanding, type OrderFindingAnswer } from "./order-finding-state";
import { appendOrderEventInTransaction } from "./order-ledger";
import { openReviewOf } from "./order-review";
import { assertOrderRunning } from "./order-status";
import type { ReviewFinding } from "./station-review-artifact";

const now = (): string => new Date().toISOString();

export function raiseOrderFinding(
  db: Database,
  orderId: string,
  finding: ReviewFinding,
  worker: string,
  at = now(),
): number {
  const row = openReviewOf(db, orderId);
  if (!row) {
    throw fail("review_not_open", { orderId });
  }
  if (row.reviewer !== worker) {
    throw fail("review_not_its_reviewer", { reviewId: row.id, reviewer: row.reviewer, worker });
  }
  assertOrderRunning(db, orderId);
  return writeTransaction(db, () => {
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
  });
}

export function assertFindingAnswersOwed(
  db: Database,
  orderId: string,
  answers: readonly OrderFindingAnswer[],
): void {
  for (const given of answers) {
    const finding = findingStanding(db, given.finding);
    if (finding?.orderId !== orderId) {
      throw fail("finding_unknown", { orderId, finding: given.finding });
    }
    if (finding.answer !== null) {
      throw fail("finding_answered", { finding: given.finding, answer: finding.answer });
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
    throw fail("worker_not_builder", { worker });
  }
  assertOrderRunning(db, orderId);
  writeTransaction(db, () => {
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
  });
}
