import type { Database } from "bun:sqlite";
import { assertOperator } from "./factory-operator";
import { latestApprovedPlan } from "./order-approved-plan";
import { latestArtifact } from "./order-artifacts";
import { assertNoRunningAttempt } from "./order-attempt";
import { appendOrderEvent, appendOrderEventInTransaction, now } from "./order-ledger";
import { assertNext } from "./order-state";
import type { Station } from "./station";

function awaitingArtifact(db: Database, orderId: string, act: "approve" | "return") {
  const { station } = assertNext(db, orderId, act);
  const artifact = latestArtifact(db, orderId, station);
  if (!artifact) throw new Error(`order ${orderId} has no ${station} artifact`);
  return { station, artifact };
}

export function approveOrder(
  db: Database,
  orderId: string,
  worker: string,
  reason: string | undefined,
  at = now(),
): Station {
  assertOperator(db, worker, "approve an artifact");
  const { station, artifact } = awaitingArtifact(db, orderId, "approve");
  if (station === "build" && !reason?.trim()) throw new Error("build approval reason must not be empty");
  appendOrderEvent(db, orderId, { kind: "artifact_approved", worker, artifactId: artifact.id, reason }, at);
  return station;
}

export function returnOrderArtifact(
  db: Database,
  orderId: string,
  worker: string,
  reason: string,
  at = now(),
): Station {
  assertOperator(db, worker, "return an artifact");
  if (reason.trim() === "") throw new Error("artifact return reason must not be empty");
  const { station, artifact } = awaitingArtifact(db, orderId, "return");
  appendOrderEvent(
    db,
    orderId,
    { kind: "artifact_returned", worker, station, artifactId: artifact.id, reason },
    at,
  );
  return station;
}

export function returnApprovedPlan(
  db: Database,
  orderId: string,
  worker: string,
  reason: string,
  at = now(),
): void {
  assertOperator(db, worker, "return an approved plan");
  if (reason.trim() === "") throw new Error("plan return reason must not be empty");
  assertNext(db, orderId, "return", "plan");
  assertNoRunningAttempt(db, orderId, "return to planning");
  const plan = latestApprovedPlan(db, orderId);
  if (!plan) throw new Error(`order ${orderId} has no approved plan`);
  appendOrderEvent(
    db,
    orderId,
    { kind: "artifact_returned", worker, station: "plan", artifactId: plan.id, reason },
    at,
  );
}

export function returnReviewToBuild(
  db: Database,
  orderId: string,
  worker: string,
  reason: string,
  at = now(),
): void {
  assertOperator(db, worker, "return review to build");
  if (reason.trim() === "") throw new Error("artifact return reason must not be empty");
  assertNext(db, orderId, "return", "build");
  assertNoRunningAttempt(db, orderId, "return to build");
  const build = latestArtifact(db, orderId, "build");
  const review = latestArtifact(db, orderId, "review");
  if (!build || !review) throw new Error(`order ${orderId} has no Build and Review artifacts`);
  db.transaction(() => {
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "artifact_returned", worker, station: "review", artifactId: review.id, reason },
      at,
    );
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "artifact_returned", worker, station: "build", artifactId: build.id, reason },
      at,
    );
  })();
}
