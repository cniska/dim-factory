import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { readApprovedPlan } from "./order";
import { finishAttempt } from "./order-attempt";
import { currentOrderCommits } from "./order-commits";
import { raiseOrderFinding } from "./order-finding";
import { type FindingStanding, orderFindingStandings } from "./order-finding-state";
import {
  abortStrandedReview,
  closeOrderReview,
  openOrderReview,
  recordOrderReviewArtifact,
} from "./order-review";
import type { StationRun } from "./station";
import { type BriefedOrder, briefHeader } from "./station-brief";
import { stationDirectory } from "./station-directory";
import type { PlanSlice } from "./station-plan-artifact";
import { parseReviewReport, type ReviewFinding } from "./station-review-artifact";
import { renderReviewReport } from "./station-review-report";
import type { Capability } from "./worker-capabilities";

export class ReviewRefused extends Error {
  constructor(
    readonly code: "not_a_repo" | "worktree_dirty" | "head_unrecorded" | "no_commit",
    message: string,
  ) {
    super(message);
  }
}

const REVIEWER_CAPABILITIES: Capability[] = ["bootstrap-worker", "read-files", "read-history", "ask-dim"];

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
  const first = current[0] as { sha: string };
  const parent = git(dir, ["rev-parse", `${first.sha}^`]);
  return { base: parent.ok ? parent.out : first.sha, head: head.out };
}

function earlierFindings(db: Database, orderId: string, reviewId: number): FindingStanding[] {
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
  context: { plan: { body: string; slices: readonly PlanSlice[] }; earlier: FindingStanding[] },
  returned: { body: string; feedback: string } | null = null,
): string {
  return [
    ...briefHeader("reviewer", "dim-review", order),
    "",
    "## Diff",
    `\`git diff ${range.base}..${range.head}\``,
    "",
    "## Approved plan",
    context.plan.body,
    ...(context.plan.slices.length > 0
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

type ReviewOutcome = { review: number; reviewer: string; findings: number };

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

export const reviewStation: StationRun<ReviewedRound, ReviewOutcome> = {
  station: "review",
  capabilities: REVIEWER_CAPABILITIES,
  outputSchema: `${import.meta.dir}/station-review-artifact.schema.json`,
  prepare: (db, order, { dir, returned, assignmentId }) => {
    const plan = readApprovedPlan(db, order.id);
    if (!plan) throw new Error(`order ${order.id} has no approved plan to review against`);
    abortStrandedReview(db, order.id);
    const cwd = stationDirectory(dir, order.id);
    const range = reviewRange(db, order.id, cwd);
    const opened = openOrderReview(db, order.id, { assignmentId, baseSha: range.base, headSha: range.head });
    const round = { id: opened.id, ...range, dir: cwd };
    return {
      cwd,
      brief: reviewerBrief(
        order,
        round,
        { plan, earlier: earlierFindings(db, order.id, round.id) },
        returned ? { body: returned.body, feedback: returned.reason } : null,
      ),
      abort: () => closeOrderReview(db, round.id, "aborted"),
      context: round,
    };
  },
  accept: (db, output, turn, round) => {
    const report = parseReviewReport(output);
    assertLocations(report.findings, round);
    writeTransaction(db, () => {
      for (const finding of report.findings) raiseOrderFinding(db, turn.orderId, finding, turn.worker);
      recordOrderReviewArtifact(db, turn.orderId, renderReviewReport(db, round.id, report), turn.worker);
      db.run("UPDATE factory_order_review SET reviewer = ? WHERE id = ?", [turn.worker, round.id]);
      closeOrderReview(db, round.id, "closed");
      finishAttempt(db, turn.orderId, "succeeded", undefined, new Date().toISOString());
    });
    return { review: round.id, reviewer: turn.worker, findings: report.findings.length };
  },
};
