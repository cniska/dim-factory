import type { Database } from "bun:sqlite";
import {
  approveOrderBuild,
  approveOrderPlan,
  completeOrderSlice,
  nextOrderSlice,
  recordOrderBuild,
  recordOrderPlan,
} from "./factory-order-artifacts";
import { recordOrderCheck } from "./factory-order-evidence";
import { moveOrder } from "./factory-order-lifecycle";
import { approveOrderReview, closeOrderReview, recordOrderReviewArtifact } from "./factory-order-review";
import { reviewIn } from "./fixtures.test-support";

export function approvePlanAndMoveToBuild(db: Database, orderId: string, operator: string): void {
  recordOrderPlan(db, orderId, "## Outcome\n\nBuild the requested result.", operator, [
    { title: "Build the requested result", outcome: "It is verified." },
  ]);
  approveOrderPlan(db, orderId, operator);
  moveOrder(db, orderId, "build", operator);
}

export function approveFinalBuildAt(
  db: Database,
  orderId: string,
  head: string,
  builder: string,
  operator: string,
): void {
  recordOrderCheck(db, orderId, { command: "bun run verify", exitCode: 0, result: "green" }, builder);
  recordOrderBuild(db, orderId, "## Outcome\n\nThe requested result is built.", head, builder);
  completeOrderSlice(db, orderId, nextOrderSlice(db, orderId)?.id as number, builder);
  approveOrderBuild(db, orderId, operator, "the requested result is present");
}

export function approveReviewAt(db: Database, orderId: string, head: string, operator: string): void {
  const opened = reviewIn(db, orderId, operator, undefined, head);
  recordOrderReviewArtifact(db, orderId, "## Outcome\n\nClean.", opened.reviewer);
  closeOrderReview(db, opened.review, "closed", opened.reviewer);
  approveOrderReview(db, orderId, operator);
}
