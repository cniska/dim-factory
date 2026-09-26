import type { Database } from "bun:sqlite";
import { latestApprovedPlan } from "./order-approved-plan";
import { latestArtifact, nextOrderSlice, type StoredArtifact } from "./order-artifacts";
import {
  carriedThroughRewrites,
  latestOrderCommit,
  pendingRebaseConflict,
  rewrittenHead,
} from "./order-commits";
import { orderFindingStandings, owesAnswer } from "./order-finding-state";
import type { Station } from "./station";

export type OrderState =
  | { station: Station; next: "run" | "approve" }
  | { station: "review"; next: "rule" }
  | { station: "ship"; next: "ship" };

type Artifact = Pick<StoredArtifact, "id" | "headSha" | "reviewId">;

function wasReturned(db: Database, artifact: Artifact): boolean {
  return (
    db
      .query("SELECT 1 FROM factory_order_event WHERE kind = 'artifact_returned' AND artifact_id = ?")
      .get(artifact.id) !== null
  );
}

function approvedArtifacts(db: Database, orderId: string, kind: "build" | "review"): Artifact[] {
  return db
    .query<Artifact, [string, string]>(
      `SELECT a.id, a.head_sha AS headSha, a.review_id AS reviewId FROM factory_order_artifact a
       WHERE a.order_id = ? AND a.kind = ? AND EXISTS (
         SELECT 1 FROM factory_order_event e WHERE e.kind = 'artifact_approved' AND e.artifact_id = a.id
       )`,
    )
    .all(orderId, kind);
}

function buildCovers(db: Database, orderId: string, artifact: Artifact, head: string | null): boolean {
  return rewrittenHead(db, orderId, artifact.headSha as string) === head;
}

function reviewCovers(db: Database, orderId: string, artifact: Artifact, head: string | null): boolean {
  const round = db
    .query<{ headSha: string; findings: number }, [number]>(
      `SELECT r.head_sha AS headSha,
              (SELECT count(*) FROM factory_order_finding f WHERE f.review_id = r.id) AS findings
       FROM factory_order_review r WHERE r.id = ?`,
    )
    .get(artifact.reviewId as number);
  return round?.findings === 0 && carriedThroughRewrites(db, orderId, round.headSha) === head;
}

export function orderState(db: Database, orderId: string): OrderState {
  if (!latestApprovedPlan(db, orderId)) {
    const plan = latestArtifact(db, orderId, "plan");
    return { station: "plan", next: plan && !wasReturned(db, plan) ? "approve" : "run" };
  }
  const head = latestOrderCommit(db, orderId)?.sha ?? null;
  const findings = orderFindingStandings(db, orderId);
  if (nextOrderSlice(db, orderId) || pendingRebaseConflict(db, orderId) || findings.some(owesAnswer)) {
    return { station: "build", next: "run" };
  }
  if (!approvedArtifacts(db, orderId, "build").some((one) => buildCovers(db, orderId, one, head))) {
    const build = latestArtifact(db, orderId, "build");
    const ready = build !== null && buildCovers(db, orderId, build, head) && !wasReturned(db, build);
    return { station: "build", next: ready ? "approve" : "run" };
  }
  if (!approvedArtifacts(db, orderId, "review").some((one) => reviewCovers(db, orderId, one, head))) {
    if (findings.some((finding) => finding.state === "awaiting_owner"))
      return { station: "review", next: "rule" };
    const review = latestArtifact(db, orderId, "review");
    const ready = review !== null && reviewCovers(db, orderId, review, head) && !wasReturned(db, review);
    return { station: "review", next: ready ? "approve" : "run" };
  }
  return { station: "ship", next: "ship" };
}
