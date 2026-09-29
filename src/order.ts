import type { Database } from "bun:sqlite";
import { runningAttempt } from "./order-attempt";
import { currentOrderCommits } from "./order-commits";
import {
  type ApprovedPlan,
  type ArtifactOf,
  fail,
  type Order,
  type OrderArtifact,
  type OrderSliceRecord,
  type PlannedSlice,
  type ShipRun,
} from "./order-contract";
import { appendOrderEvent } from "./order-ledger";
import { insertShipRun, updateShipCleanup } from "./order-ship-run";
import { isTerminalOrderStatus } from "./order-status";
import { loadOrder, loadPlanContent } from "./order-store";
import type { ShipTeardown } from "./ship-contract";
import type { Station } from "./station-contract";
import { assertOperator } from "./worker";

export type OrderState = { station: Station; next: "run" | "approve" } | { station: null; next: "ship" };

function latestOf<Artifact extends OrderArtifact>(artifacts: Artifact[]): Artifact | null {
  let latest: Artifact | null = null;
  for (const artifact of artifacts) {
    if (latest === null || artifact.revision > latest.revision) latest = artifact;
  }
  return latest;
}

const plans = (order: Order) => order.artifacts.filter((a): a is ArtifactOf<"plan"> => a.kind === "plan");
const builds = (order: Order) => order.artifacts.filter((a): a is ArtifactOf<"build"> => a.kind === "build");
const reviews = (order: Order) =>
  order.artifacts.filter((a): a is ArtifactOf<"review"> => a.kind === "review");

const standing = (artifact: OrderArtifact): boolean => artifact.approved && !artifact.returned;

function approvedPlan(order: Order): ArtifactOf<"plan"> | null {
  const plan = latestOf(plans(order));
  return plan && standing(plan) ? plan : null;
}

function sliceLeft(order: Order, plan: ArtifactOf<"plan">): boolean {
  return order.slices.some((slice) => slice.artifactId === plan.id && !slice.done);
}

export function nextSlice(order: Order): OrderSliceRecord | null {
  const plan = approvedPlan(order);
  if (plan === null) return null;
  const left = order.slices.filter((slice) => slice.artifactId === plan.id && !slice.done);
  return left.sort((a, b) => a.ordinal - b.ordinal)[0] ?? null;
}

export function lastSliceOrdinal(order: Order): number | null {
  const plan = approvedPlan(order);
  if (plan === null) return null;
  const ordinals = order.slices.filter((slice) => slice.artifactId === plan.id).map((slice) => slice.ordinal);
  return ordinals.length === 0 ? null : Math.max(...ordinals);
}

export function nextOrderSlice(db: Database, orderId: string): PlannedSlice | null {
  const plan = readApprovedPlan(db, orderId);
  return plan === null ? null : plan.next;
}

export function readApprovedPlan(db: Database, orderId: string): ApprovedPlan | null {
  const order = loadOrder(db, orderId);
  const plan = approvedPlan(order);
  if (plan === null) return null;
  const content = loadPlanContent(db, plan.id);
  const next = nextSlice(order);
  if (next === null) return { id: plan.id, ...content, next: null };
  const planned = content.slices.find((slice) => slice.id === next.id);
  if (planned === undefined) throw new Error(`slice ${next.id} is not in plan ${plan.id}'s recorded slices`);
  return { id: plan.id, ...content, next: planned };
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

function buildCovers(order: Order, build: ArtifactOf<"build">, head: string | null): boolean {
  return rewrittenHead(order, build.headSha) === head;
}

function reviewCovers(order: Order, review: ArtifactOf<"review">, head: string | null): boolean {
  const round = order.reviews.find((r) => r.id === review.reviewId);
  if (!round || order.findings.some((finding) => finding.reviewId === round.id)) return false;
  return carriedThroughRewrites(order, round.headSha) === head;
}

function stationState<Artifact extends ArtifactOf<"build"> | ArtifactOf<"review">>(
  order: Order,
  station: "build" | "review",
  artifacts: Artifact[],
  plan: ArtifactOf<"plan">,
  head: string | null,
  covers: (order: Order, artifact: Artifact, head: string | null) => boolean,
): OrderState | null {
  const latest = latestOf(artifacts);
  const after = latest !== null && latest.id > plan.id;
  if (after && standing(latest) && covers(order, latest, head)) return null;
  const ready = after && covers(order, latest, head) && !latest.returned;
  return { station, next: ready ? "approve" : "run" };
}

export function next(order: Order): OrderState {
  const plan = approvedPlan(order);
  if (!plan) {
    const written = latestOf(plans(order));
    return { station: "plan", next: written && !written.returned ? "approve" : "run" };
  }
  const head = orderHead(order);
  if (sliceLeft(order, plan) || conflictPending(order) || headCheckFailed(order, head) || owesAnswer(order)) {
    return { station: "build", next: "run" };
  }
  return (
    stationState(order, "build", builds(order), plan, head, buildCovers) ??
    stationState(order, "review", reviews(order), plan, head, reviewCovers) ?? { station: null, next: "ship" }
  );
}

export function orderState(db: Database, orderId: string): OrderState {
  return next(loadOrder(db, orderId));
}

export function describeState(state: OrderState): string {
  return state.station === null ? state.next : `${state.next} at ${state.station}`;
}

export type OrderAct = "plan" | "build" | "review" | "approve" | "return" | "ship";

export type RunningAttempt = { worker: string; runId: string };

function returnsTo(state: OrderState, destination: Station): boolean {
  switch (destination) {
    case "plan":
      return state.station === "build" || (state.station === "plan" && state.next === "approve");
    case "build":
      return (state.station === "build" || state.station === "review") && state.next === "approve";
    case "review":
      return state.station === "review" && state.next === "approve";
  }
}

function admits(state: OrderState, act: OrderAct, to: Station | undefined): boolean {
  switch (act) {
    case "plan":
    case "build":
    case "review":
      return state.station === act && state.next === "run";
    case "approve":
      return state.next === "approve";
    case "ship":
      return state.next === "ship";
    case "return": {
      const destination = to ?? state.station;
      return destination !== null && returnsTo(state, destination);
    }
  }
}

function heldAction(act: OrderAct, state: OrderState, to: Station | undefined): string | null {
  switch (act) {
    case "plan":
      return "start a planner";
    case "build":
      return "start a builder";
    case "review":
      return "start a reviewer";
    case "return":
      return `return to ${to ?? state.station}`;
    default:
      return null;
  }
}

export function admit(order: Order, act: OrderAct, running: RunningAttempt | null, to?: Station): OrderState {
  if (isTerminalOrderStatus(order.status))
    throw fail("order_terminal", { orderId: order.id, status: order.status, act });
  const state = next(order);
  if (!admits(state, act, to))
    throw fail("not_next", { orderId: order.id, station: state.station, next: state.next, act });
  if (act === "return" && conflictPending(order))
    throw fail("rebase_conflict_pending", { orderId: order.id, act });
  const held = heldAction(act, state, to);
  if (held !== null && running !== null) {
    throw fail("order_held_by_run", {
      orderId: order.id,
      worker: running.worker,
      runId: running.runId,
      act: held,
    });
  }
  return state;
}

const DELEGATES: Record<OrderAct, string> = {
  plan: "delegate planning",
  build: "delegate build",
  review: "delegate review",
  approve: "approve an artifact",
  return: "return an artifact",
  ship: "ship an order",
};

export function admitAct(
  db: Database,
  orderId: string,
  act: "approve",
  worker: string,
): Extract<OrderState, { next: "approve" }>;
export function admitAct(
  db: Database,
  orderId: string,
  act: "return",
  worker: string,
  to?: Station,
): Extract<OrderState, { station: Station }>;
export function admitAct(
  db: Database,
  orderId: string,
  act: OrderAct,
  worker: string,
  to?: Station,
): OrderState;
export function admitAct(
  db: Database,
  orderId: string,
  act: OrderAct,
  worker: string,
  to?: Station,
): OrderState {
  assertOperator(db, worker, DELEGATES[act]);
  return admit(loadOrder(db, orderId), act, runningAttempt(db, orderId), to);
}

export function beginShip(db: Database, orderId: string, worker: string, retry: boolean): string[] {
  admitAct(db, orderId, "ship", worker);
  if (retry) appendOrderEvent(db, orderId, { kind: "ship_retried", worker });
  return currentOrderCommits(db, orderId).map((row) => row.sha);
}

export function recordShipRun(db: Database, orderId: string, run: ShipRun, at?: string): number {
  return insertShipRun(db, orderId, run, at);
}

export function recordShipCleanup(
  db: Database,
  orderId: string,
  shipRunId: number,
  cleanup: ShipTeardown,
): void {
  updateShipCleanup(db, orderId, shipRunId, cleanup);
}
