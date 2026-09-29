import type { Database } from "bun:sqlite";
import { latestApprovedPlan } from "./order-approved-plan";
import { latestArtifact, nextOrderSlice, type StoredArtifact } from "./order-artifacts";
import {
  carriedThroughRewrites,
  latestOrderCommit,
  pendingRebaseConflict,
  rewrittenHead,
} from "./order-commits";
import { fail } from "./order-contract";
import { orderFindingStandings, owesAnswer } from "./order-finding-state";
import { failedHeadCheck } from "./order-head-check";
import { isTerminalOrderStatus, orderStatus } from "./order-status";
import type { Station } from "./station";

export type NextAct = "run" | "approve" | "ship";

export type OrderState = { station: Station; next: "run" | "approve" } | { station: null; next: "ship" };

type Artifact = Pick<StoredArtifact, "id" | "headSha" | "reviewId">;

function wasReturned(db: Database, artifact: Artifact): boolean {
  return (
    db
      .query("SELECT 1 FROM factory_order_event WHERE kind = 'artifact_returned' AND artifact_id = ?")
      .get(artifact.id) !== null
  );
}

function approvedArtifact(
  db: Database,
  orderId: string,
  kind: "build" | "review",
  planId: number,
): Artifact | null {
  return db
    .query<Artifact, [string, string, number]>(
      `SELECT a.id, a.head_sha AS headSha, a.review_id AS reviewId FROM factory_order_artifact a
       WHERE a.order_id = ? AND a.kind = ? AND a.id > ? AND EXISTS (
         SELECT 1 FROM factory_order_event e WHERE e.kind = 'artifact_approved' AND e.artifact_id = a.id
       ) AND NOT EXISTS (
         SELECT 1 FROM factory_order_event e WHERE e.kind = 'artifact_returned' AND e.artifact_id = a.id
       ) AND a.revision = (
         SELECT max(latest.revision) FROM factory_order_artifact latest
         WHERE latest.order_id = a.order_id AND latest.kind = a.kind
       )`,
    )
    .get(orderId, kind, planId);
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
  const plan = latestApprovedPlan(db, orderId);
  if (!plan) {
    const plan = latestArtifact(db, orderId, "plan");
    return { station: "plan", next: plan && !wasReturned(db, plan) ? "approve" : "run" };
  }
  const head = latestOrderCommit(db, orderId)?.sha ?? null;
  const findings = orderFindingStandings(db, orderId);
  if (
    nextOrderSlice(db, orderId) ||
    pendingRebaseConflict(db, orderId) ||
    failedHeadCheck(db, orderId) ||
    findings.some(owesAnswer)
  ) {
    return { station: "build", next: "run" };
  }
  const approvedBuild = approvedArtifact(db, orderId, "build", plan.id);
  if (!approvedBuild || !buildCovers(db, orderId, approvedBuild, head)) {
    const build = latestArtifact(db, orderId, "build");
    const ready =
      build !== null &&
      build.id > plan.id &&
      buildCovers(db, orderId, build, head) &&
      !wasReturned(db, build);
    return { station: "build", next: ready ? "approve" : "run" };
  }
  const approvedReview = approvedArtifact(db, orderId, "review", plan.id);
  if (!approvedReview || !reviewCovers(db, orderId, approvedReview, head)) {
    const review = latestArtifact(db, orderId, "review");
    const ready =
      review !== null &&
      review.id > plan.id &&
      reviewCovers(db, orderId, review, head) &&
      !wasReturned(db, review);
    return { station: "review", next: ready ? "approve" : "run" };
  }
  return { station: null, next: "ship" };
}

export function describeState(state: OrderState): string {
  return state.station === null ? state.next : `${state.next} at ${state.station}`;
}

export type OrderAct = "plan" | "build" | "review" | "approve" | "return" | "ship";

const ENTERS: Record<Exclude<OrderAct, "return">, (state: OrderState) => boolean> = {
  plan: (state) => state.station === "plan" && state.next === "run",
  build: (state) => state.station === "build" && state.next === "run",
  review: (state) => state.station === "review" && state.next === "run",
  approve: (state) => state.next === "approve",
  ship: (state) => state.next === "ship",
};

const RETURNS_TO: Record<Station, (state: OrderState) => boolean> = {
  plan: (state) => state.station === "build" || (state.station === "plan" && state.next === "approve"),
  build: (state) => (state.station === "build" || state.station === "review") && state.next === "approve",
  review: (state) => state.station === "review" && state.next === "approve",
};

function admits(state: OrderState, act: OrderAct, to: Station | undefined): boolean {
  if (act !== "return") return ENTERS[act](state);
  const destination = to ?? state.station;
  return destination !== null && RETURNS_TO[destination](state);
}

export function assertNext(
  db: Database,
  orderId: string,
  act: "approve",
): Extract<OrderState, { next: "approve" }>;
export function assertNext(
  db: Database,
  orderId: string,
  act: "return",
  to?: Station,
): Extract<OrderState, { station: Station }>;
export function assertNext(db: Database, orderId: string, act: OrderAct, to?: Station): OrderState;
export function assertNext(db: Database, orderId: string, act: OrderAct, to?: Station): OrderState {
  const status = orderStatus(db, orderId);
  if (isTerminalOrderStatus(status)) throw fail("order_terminal", { orderId, status, act });
  const state = orderState(db, orderId);
  if (!admits(state, act, to)) throw fail("not_next", { orderId, waitsOn: describeState(state), act });
  return state;
}
