import type { Database } from "bun:sqlite";
import type { Order, OrderArtifact } from "./order-contract";
import { loadOrder } from "./order-store";
import type { Station } from "./station";

export type OrderState = { station: Station; next: "run" | "approve" } | { station: null; next: "ship" };

function latestOf(order: Order, kind: Station): OrderArtifact | null {
  let latest: OrderArtifact | null = null;
  for (const artifact of order.artifacts) {
    if (artifact.kind === kind && (latest === null || artifact.revision > latest.revision)) latest = artifact;
  }
  return latest;
}

const standing = (artifact: OrderArtifact): boolean => artifact.approved && !artifact.returned;

function approvedPlan(order: Order): OrderArtifact | null {
  const plan = latestOf(order, "plan");
  return plan && standing(plan) ? plan : null;
}

function sliceLeft(order: Order, plan: OrderArtifact): boolean {
  return order.slices.some((slice) => slice.artifactId === plan.id && !slice.done);
}

export function orderHead(order: Order): string | null {
  const retired = new Set(order.commits.map((commit) => commit.retires));
  return order.commits.filter((commit) => !retired.has(commit.sha)).at(-1)?.sha ?? null;
}

function replacements(order: Order): { sha: string; retires: string; patchEqual: number | null }[] {
  const runs = new Map(order.shipRuns.map((run) => [run.id, run]));
  return order.commits.flatMap((commit) => {
    const run = commit.shipRunId === null ? undefined : runs.get(commit.shipRunId);
    return run && commit.retires !== null && run.oldHead === commit.retires
      ? [{ sha: commit.sha, retires: commit.retires, patchEqual: run.patchEqual }]
      : [];
  });
}

function rewrittenHead(order: Order, sha: string): string {
  let current = sha;
  for (const replacement of replacements(order))
    if (replacement.retires === current) current = replacement.sha;
  return current;
}

function carriedThroughRewrites(order: Order, sha: string): string | null {
  let current = sha;
  for (const replacement of replacements(order)) {
    if (replacement.retires !== current) continue;
    if (replacement.patchEqual !== 1) return null;
    current = replacement.sha;
  }
  return current;
}

function conflictPending(order: Order): boolean {
  const latest = order.shipRuns.at(-1);
  return latest?.outcome === "conflict" && !order.commits.some((commit) => commit.shipRunId === latest.id);
}

function headCheckFailed(order: Order, head: string | null): boolean {
  const check = order.checks.filter((c) => head === null || c.headSha === head).at(-1);
  return check !== undefined && check.exitCode !== 0;
}

function owesAnswer(order: Order): boolean {
  return order.findings.some((finding) => !finding.answered);
}

function buildCovers(order: Order, build: OrderArtifact, head: string | null): boolean {
  return rewrittenHead(order, build.headSha as string) === head;
}

function reviewCovers(order: Order, review: OrderArtifact, head: string | null): boolean {
  const round = order.reviews.find((r) => r.id === review.reviewId);
  if (!round || order.findings.some((finding) => finding.reviewId === round.id)) return false;
  return carriedThroughRewrites(order, round.headSha) === head;
}

function stationState(
  order: Order,
  station: "build" | "review",
  plan: OrderArtifact,
  head: string | null,
  covers: (order: Order, artifact: OrderArtifact, head: string | null) => boolean,
): OrderState | null {
  const latest = latestOf(order, station);
  const after = latest !== null && latest.id > plan.id;
  if (after && standing(latest) && covers(order, latest, head)) return null;
  const ready = after && covers(order, latest, head) && !latest.returned;
  return { station, next: ready ? "approve" : "run" };
}

export function next(order: Order): OrderState {
  const plan = approvedPlan(order);
  if (!plan) {
    const written = latestOf(order, "plan");
    return { station: "plan", next: written && !written.returned ? "approve" : "run" };
  }
  const head = orderHead(order);
  if (sliceLeft(order, plan) || conflictPending(order) || headCheckFailed(order, head) || owesAnswer(order)) {
    return { station: "build", next: "run" };
  }
  return (
    stationState(order, "build", plan, head, buildCovers) ??
    stationState(order, "review", plan, head, reviewCovers) ?? { station: null, next: "ship" }
  );
}

export function orderState(db: Database, orderId: string): OrderState {
  return next(loadOrder(db, orderId));
}

export function describeState(state: OrderState): string {
  return state.station === null ? state.next : `${state.next} at ${state.station}`;
}
