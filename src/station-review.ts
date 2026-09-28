import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { assertOperator } from "./factory-operator";
import type { HarnessAdapter } from "./harness";
import { workerFailureReason } from "./harness-launch";
import type { HarnessName } from "./harness-name";
import { latestApprovedPlan } from "./order-approved-plan";
import type { ReturnedOrderArtifact } from "./order-artifacts";
import { finishAttempt } from "./order-attempt";
import { carriedThroughRewrites, currentOrderCommits } from "./order-commits";
import { raiseOrderFinding } from "./order-finding";
import { type FindingStanding, orderFindingStandings } from "./order-finding-state";
import { appendOrderEvent } from "./order-ledger";
import {
  abortStrandedReview,
  closeOrderReview,
  openOrderReview,
  recordOrderReviewArtifact,
} from "./order-review";
import { assertNext } from "./order-state";
import { startStationAttempt } from "./station-attempt";
import { type BriefedOrder, briefHeader } from "./station-brief";
import { stationDirectory } from "./station-directory";
import type { PlanSlice } from "./station-plan-artifact";
import { parseReviewReport, type ReviewFinding } from "./station-review-artifact";
import { renderReviewReport } from "./station-review-report";
import { type OrderStationTurn, runOrderStationLive } from "./station-worker";
import type { Capability } from "./worker-capabilities";

export class ReviewRefused extends Error {
  constructor(
    readonly code: "not_a_repo" | "worktree_dirty" | "head_unrecorded" | "no_commit",
    message: string,
  ) {
    super(message);
  }
}

export const REVIEWER_CAPABILITIES: Capability[] = [
  "bootstrap-worker",
  "read-files",
  "read-history",
  "ask-dim",
];

const REVIEW_OUTPUT_SCHEMA = `${import.meta.dir}/station-review-artifact.schema.json`;

function git(dir: string, args: string[]): { ok: boolean; out: string; raw: string } {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  const raw = run.stdout.toString();
  return { ok: run.success, out: raw.trim(), raw };
}

export function reviewRange(db: Database, orderId: string, dir: string): { base: string; head: string } {
  const head = git(dir, ["rev-parse", "HEAD"]);
  if (!head.ok) throw new ReviewRefused("not_a_repo", `${dir} is not a git repo that can be read`);
  if (git(dir, ["status", "--porcelain", "--ignore-submodules=dirty"]).out !== "") {
    throw new ReviewRefused(
      "worktree_dirty",
      `${dir} has uncommitted changes, and a round reads a commit: commit them or put them aside`,
    );
  }
  const current = currentOrderCommits(db, orderId);
  if (current.length === 0) {
    throw new ReviewRefused("no_commit", `order ${orderId} recorded no commit, so there is no slice to read`);
  }
  if (!current.some((row) => head.out.startsWith(row.sha))) {
    throw new ReviewRefused(
      "head_unrecorded",
      `${head.out} is not a commit order ${orderId} recorded; only a build turn's commit can be reviewed`,
    );
  }
  const last = db
    .query<{ head_sha: string }, [string]>(
      `SELECT r.head_sha FROM factory_order_review r
       WHERE r.order_id = ? AND r.outcome = 'closed' AND NOT EXISTS (
         SELECT 1 FROM factory_order_artifact a
         JOIN factory_order_event e ON e.artifact_id = a.id AND e.kind = 'artifact_returned'
         WHERE a.review_id = r.id
       ) AND r.opened_at > (
         SELECT coalesce(max(e.ts), '') FROM factory_order_event e
         JOIN factory_order_artifact a ON a.id = e.artifact_id
         WHERE e.order_id = r.order_id AND e.kind = 'artifact_approved' AND a.kind = 'plan'
       )
       ORDER BY r.round DESC LIMIT 1`,
    )
    .get(orderId);
  if (last) {
    const carried = carriedThroughRewrites(db, orderId, last.head_sha);
    if (carried && current.some((row) => carried.startsWith(row.sha)))
      return { base: carried, head: head.out };
    const rewrite = db
      .query<{ new_base: string }, [string]>(
        `SELECT r.new_base FROM factory_order_commit c JOIN factory_order_ship_run r ON r.id = c.ship_run_id
         WHERE c.order_id = ? ORDER BY c.id DESC LIMIT 1`,
      )
      .get(orderId);
    if (!rewrite) {
      throw new Error(`order ${orderId}'s last review read ${last.head_sha}, which it no longer carries`);
    }
    return { base: rewrite.new_base, head: head.out };
  }
  const first = current[0] as { sha: string };
  const parent = git(dir, ["rev-parse", `${first.sha}^`]);
  return { base: parent.ok ? parent.out : first.sha, head: head.out };
}

export function earlierFindings(db: Database, orderId: string, reviewId: number): FindingStanding[] {
  return orderFindingStandings(db, orderId).filter((finding) => finding.reviewId !== reviewId);
}

function earlierFindingLines(finding: FindingStanding): string[] {
  return [
    `- Finding ${finding.id} (${finding.dimension}, ${finding.file}:${finding.line}): ${finding.failure}`,
    `  - Fix asked for: ${finding.fix}`,
    `  - Builder's answer: ${finding.answer}${finding.resolution ? `: ${finding.resolution}` : ""}`,
  ];
}

export function reviewerBrief(
  order: BriefedOrder,
  range: { base: string; head: string },
  context: { plan: { body: string; slices: readonly PlanSlice[] } | null; earlier: FindingStanding[] },
  returned: { body: string; feedback: string } | null = null,
): string {
  return [
    ...briefHeader("reviewer", "dim-review", order),
    "",
    "## Diff",
    `\`git diff ${range.base}..${range.head}\``,
    "",
    "## Approved plan",
    context.plan?.body ?? "None is recorded for this order.",
    ...(context.plan && context.plan.slices.length > 0
      ? [
          "",
          "## Plan slices",
          ...context.plan.slices.map((slice, index) => `${index + 1}. ${slice.title}: ${slice.outcome}`),
        ]
      : []),
    ...(context.earlier.length > 0
      ? ["", "## Earlier findings", ...context.earlier.flatMap(earlierFindingLines)]
      : []),
    ...(returned
      ? ["", "## Returned Review artifact", returned.body, "", "## Owner feedback", returned.feedback]
      : []),
  ].join("\n");
}

type ReviewedRound = { id: number; base: string; head: string; dir: string };

function openRound(db: Database, orderId: string, dir: string, assignmentId: string): ReviewedRound {
  const range = reviewRange(db, orderId, dir);
  const round = openOrderReview(db, orderId, { assignmentId, baseSha: range.base, headSha: range.head });
  return { id: round.id, ...range, dir };
}

function reviewerRequest(
  db: Database,
  order: BriefedOrder,
  round: ReviewedRound,
  returned: ReturnedOrderArtifact | null,
) {
  return {
    cwd: round.dir,
    brief: reviewerBrief(
      order,
      round,
      { plan: latestApprovedPlan(db, order.id), earlier: earlierFindings(db, order.id, round.id) },
      returned ? { body: returned.body, feedback: returned.reason } : null,
    ),
    capabilities: REVIEWER_CAPABILITIES,
    outputSchema: REVIEW_OUTPUT_SCHEMA,
  };
}

export type ReviewOutcome = {
  review: number;
  reviewer: string;
  findings: number;
  outcome: "closed" | "aborted";
};

function assertLocations(findings: ReviewFinding[], round: ReviewedRound): void {
  if (findings.length === 0) return;
  const diff = git(round.dir, ["diff", "--name-only", "-z", `${round.base}..${round.head}`]);
  if (!diff.ok) throw new Error(`could not list the files ${round.base}..${round.head} changes`);
  const changed = new Set(diff.raw.split("\0"));
  findings.forEach((finding, index) => {
    const what = `reviewer finding ${index + 1}`;
    if (!changed.has(finding.file)) {
      throw new Error(
        `${what} names file ${finding.file}, which ${round.base}..${round.head} does not change`,
      );
    }
    const shown = git(round.dir, ["show", `${round.head}:${finding.file}`]);
    if (!shown.ok) {
      throw new Error(`${what} names file ${finding.file}, which does not exist at ${round.head}`);
    }
    const text = shown.raw;
    const lines = text.split("\n").length - (text === "" || text.endsWith("\n") ? 1 : 0);
    if (finding.line > lines) {
      throw new Error(
        `${what} names line ${finding.line} of ${finding.file}, which has ${lines} lines at ${round.head}`,
      );
    }
  });
}

function recordReviewResult(
  db: Database,
  orderId: string,
  reviewer: string,
  raw: string,
  round: ReviewedRound,
): number {
  const report = parseReviewReport(raw);
  assertLocations(report.findings, round);
  return writeTransaction(db, () => {
    for (const finding of report.findings) {
      raiseOrderFinding(db, orderId, finding, reviewer);
    }
    recordOrderReviewArtifact(db, orderId, renderReviewReport(db, round.id, report), reviewer);
    return report.findings.length;
  });
}

export async function runOrderReviewLive(
  db: Database,
  orderId: string,
  worker: string,
  options: {
    dir: string;
    env?: Record<string, string | undefined>;
    harness: HarnessName;
    adapter?: HarnessAdapter;
  },
): Promise<ReviewOutcome> {
  const order = db
    .query<BriefedOrder, [string]>("SELECT id, title, description, line FROM factory_order WHERE id = ?")
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  assertOperator(db, worker, "delegate review");
  assertNext(db, orderId, "review");
  abortStrandedReview(db, orderId);
  const dir = stationDirectory(options.dir, orderId);
  const harness = options.harness;
  const runId = `review-${crypto.randomUUID()}`;
  let opened: ReviewedRound | undefined;
  let claimed = false;
  let turn: OrderStationTurn;
  try {
    turn = await runOrderStationLive({
      db,
      orderId,
      station: "review",
      parentWorker: worker,
      harness,
      env: options.env,
      adapter: options.adapter,
      onAssigned: (assigned, providerSessionId, attribution) => {
        startStationAttempt(
          db,
          orderId,
          {
            runId,
            worker: assigned,
            operatorWorker: worker,
            station: "review",
            sessionId: providerSessionId,
            providerSessionId,
            ...attribution,
          },
          new Date().toISOString(),
        );
        claimed = true;
      },
      request: ({ orderWorker: assigned, returned }) => {
        opened = openRound(db, orderId, dir, assigned.assignment.id);
        return reviewerRequest(db, order, opened, returned);
      },
    });
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    if (opened) {
      const reason = workerFailureReason("reviewer did not finish reviewing", failure, undefined);
      try {
        closeOrderReview(db, opened.id, "aborted");
        if (claimed) finishAttempt(db, orderId, "failed", reason, new Date().toISOString());
      } catch {
        throw error;
      }
    }
    if (!claimed) {
      appendOrderEvent(db, orderId, { kind: "failed", station: "review", reason: failure });
    }
    throw error;
  }
  if (!opened) throw new Error("review round was not opened");
  if (!claimed || !turn.worker) {
    const failure = workerFailureReason(
      "reviewer did not bootstrap its worker assignment",
      turn.run.output,
      turn.run.failureReason,
    );
    closeOrderReview(db, opened.id, "aborted");
    if (claimed) finishAttempt(db, orderId, "failed", failure, new Date().toISOString());
    else appendOrderEvent(db, orderId, { kind: "failed", station: "review", reason: failure });
    throw new Error(failure);
  }
  const reviewer = turn.worker;
  db.run("UPDATE factory_order_review SET reviewer = ? WHERE id = ?", [reviewer, opened.id]);
  const outcome = turn.run.exitCode === 0 ? "closed" : "aborted";
  const reason =
    outcome === "aborted"
      ? workerFailureReason("reviewer did not finish reviewing", turn.run.output, turn.run.failureReason)
      : undefined;
  if (outcome === "aborted") {
    closeOrderReview(db, opened.id, outcome);
    finishAttempt(db, orderId, "failed", reason, new Date().toISOString());
    return { review: opened.id, reviewer, findings: 0, outcome };
  }
  let findings: number;
  try {
    findings = recordReviewResult(db, orderId, reviewer, turn.run.output, opened);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    closeOrderReview(db, opened.id, "aborted");
    finishAttempt(db, orderId, "failed", failure, new Date().toISOString());
    throw error;
  }
  closeOrderReview(db, opened.id, outcome);
  finishAttempt(db, orderId, "succeeded", undefined, new Date().toISOString());
  return { review: opened.id, reviewer, findings, outcome };
}
