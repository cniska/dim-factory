import type { Database } from "bun:sqlite";
import { type CheckoutConvention, CONVENTION_FLOOR, checkoutConvention } from "./git-commit-convention";
import { latestApprovedPlan } from "./order-approved-plan";
import {
  completeOrderBuildFollowup,
  completeOrderSlice,
  latestArtifact,
  nextOrderSlice,
  type OrderSlice,
} from "./order-artifacts";
import { pendingRebaseConflict, type RecordedConflict } from "./order-commits";
import type { BuildTurnRefused } from "./order-finding";
import { type FindingStanding, orderFindingStandings, owesAnswer } from "./order-finding-state";
import { type FailedCheck, failedHeadCheck } from "./order-head-check";
import type { Env } from "./paths";
import type { StationRun, StationTurn } from "./station";
import { type BriefedOrder, briefHeader } from "./station-brief";
import { commitBuildTurn, undoInterruptedJudgement } from "./station-build-commit";
import { continueRebaseTurn, reopenRebase } from "./station-build-rebase";
import { BUILD_TURN_SCHEMA, parseBuildTurn } from "./station-build-turn";
import type { PlanSlice } from "./station-plan-artifact";
import { writeTrace } from "./trace-store";
import type { Capability } from "./worker-capabilities";
import { workspaceContract } from "./workspace";
import { repoRoot, worktreePath } from "./worktree";

export const BUILDER_CAPABILITIES: Capability[] = [
  "bootstrap-worker",
  "read-files",
  "edit-files",
  "read-history",
  "ask-dim",
  "run-check",
];

function conventionContext({ repo, commits, observed }: CheckoutConvention): string {
  if (!observed) {
    return `The record holds ${commits} commits from ${repo}, fewer than the ${CONVENTION_FLOOR} it takes to read a convention from.`;
  }
  const kinds = observed.topKinds.length > 0 ? `, most often ${observed.topKinds.join(", ")}` : "";
  return `The record holds ${commits} commits from ${repo}. ${observed.conventionalPct}% of their subjects carry a Conventional Commits type${kinds}; subjects average ${observed.meanLength} characters and ${observed.over50Pct}% run over 50.`;
}

function workspaceLines(workspace: ReturnType<typeof workspaceContract>): string[] {
  if (!workspace) return ["The workspace profile could not be read."];
  return [
    `Ecosystem: ${workspace.ecosystems.join(", ") || "unknown"}.`,
    `Package managers: ${workspace.packageManagers.join(", ") || "none declared"}.`,
    `Check: ${workspace.checkTask?.commandLine ?? "none"}.`,
    `Format: ${workspace.formatTask?.commandLine ?? "none"}.`,
    `Tasks: ${workspace.tasks.map((one) => `${one.name}=${one.commandLine} (${one.source})`).join("; ") || "none"}.`,
  ];
}

function conflictLines(paths: readonly string[]): string[] {
  return ["## Rebase conflict", ...paths.map((path) => `- ${path}`)];
}

function sliceLine(slice: PlanSlice, ordinal: number): string {
  return `${ordinal}. ${slice.title}: ${slice.outcome}`;
}

export function builderBrief(
  order: BriefedOrder,
  plan: { body: string; slices: readonly PlanSlice[] },
  currentSlice: OrderSlice | null,
  workspace: ReturnType<typeof workspaceContract>,
  revision?: { body: string; feedback: string },
  previousFailure?: string,
  reviewFindings: ReviewFindingsForBuild = NO_REVIEW_FINDINGS,
  convention?: CheckoutConvention,
  conflicts: readonly string[] | null = null,
  redCheck: FailedCheck | null = null,
): string {
  const resolving = conflicts !== null;
  return [
    ...briefHeader("builder", "dim-build", order, !resolving),
    "",
    "## Workspace",
    ...workspaceLines(workspace),
    ...(!resolving && convention ? ["", "## Commit convention", conventionContext(convention)] : []),
    "",
    "## Approved plan",
    plan.body,
    "",
    "## Slices",
    ...plan.slices.map((slice, index) => sliceLine(slice, index + 1)),
    ...(currentSlice ? ["", "## Current slice", sliceLine(currentSlice, currentSlice.ordinal)] : []),
    ...(revision
      ? ["", "## Returned Build artifact", revision.body, "", "## Owner feedback", revision.feedback]
      : []),
    ...(reviewFindings.work.length > 0
      ? ["", "## Review findings", ...reviewFindings.work.map((one) => `- ${one.brief}`)]
      : []),
    ...(resolving ? ["", ...conflictLines(conflicts)] : []),
    ...(redCheck
      ? [
          "",
          "## Red check",
          `\`${redCheck.command}\` exited ${redCheck.exitCode}:`,
          "```",
          redCheck.result,
          "```",
        ]
      : []),
    ...(previousFailure ? ["", "## Previous failed Build attempt", previousFailure] : []),
  ].join("\n");
}

const COMMIT_CORRECTIONS = 2;

export function commitCorrectionBrief(subject: string, refusal: BuildTurnRefused): string {
  return [
    "## Commit refused",
    refusal.code === "comment_added"
      ? `The runner refused to commit your worktree with the subject \`${subject}\` before running its check:`
      : `The runner's commit of your worktree with the subject \`${subject}\` was refused before its check ran:`,
    "",
    refusal.message,
  ].join("\n");
}

export type ReviewFindingsForBuild = { work: readonly { finding: number; brief: string }[] };

const NO_REVIEW_FINDINGS: ReviewFindingsForBuild = { work: [] };

export function reviewFindingsForBuild(db: Database, orderId: string): ReviewFindingsForBuild {
  const review = db
    .query<{ outcome: string | null }, [string]>(
      "SELECT outcome FROM factory_order_review WHERE order_id = ? ORDER BY round DESC LIMIT 1",
    )
    .get(orderId);
  if (review?.outcome !== "closed") return NO_REVIEW_FINDINGS;
  return {
    work: orderFindingStandings(db, orderId)
      .filter(owesAnswer)
      .map((finding) => ({
        finding: finding.id,
        brief: `${describeFinding(finding)}\n  Fix: ${finding.fix}`,
      })),
  };
}

function describeFinding(finding: FindingStanding): string {
  return `Finding ${finding.id} (${finding.dimension}, ${finding.file}:${finding.line}): ${finding.failure}`;
}

export type BuildOutcome = { builder: string; runId: string; worktree: string };

type Rebase = { conflict: RecordedConflict; paths: string[] };

type BuildContext = {
  line: BriefedOrder["line"];
  finalOrdinal: number;
  currentSlice: OrderSlice | null;
  rebase: Rebase | null;
  owed: readonly number[];
  priorBuild: number;
  worktree: string;
  env?: Env;
  checkSandbox?: string[];
};

async function resolveRebase(db: Database, turn: StationTurn, context: BuildContext, rebase: Rebase) {
  for (let paths = rebase.paths; ; ) {
    const continued = continueRebaseTurn({
      db,
      orderId: turn.orderId,
      worktree: context.worktree,
      conflict: rebase.conflict,
      paths,
      env: context.env,
      checkSandbox: context.checkSandbox,
    });
    if ("sha" in continued) return;
    paths = continued.conflicts;
    await turn.resume(conflictLines(paths).join("\n"));
  }
}

async function commitSlice(db: Database, output: string, turn: StationTurn, context: BuildContext) {
  for (let corrections = 0; ; corrections++) {
    const parsed = parseBuildTurn(output.trim());
    const committed = commitBuildTurn({
      db,
      orderId: turn.orderId,
      runId: turn.runId,
      builder: turn.worker,
      worktree: context.worktree,
      turn: parsed,
      owed: context.owed,
      finalSlice: context.currentSlice === null || context.currentSlice.ordinal === context.finalOrdinal,
      proofRequired: context.line === "fix" && context.currentSlice !== null,
      env: context.env,
      checkSandbox: context.checkSandbox,
    });
    if (!("refused" in committed)) return;
    if (corrections === COMMIT_CORRECTIONS) throw committed.refused;
    output = await turn.resume(commitCorrectionBrief(parsed.subject, committed.refused));
  }
}

export const buildStation: StationRun<BuildContext, BuildOutcome> = {
  station: "build",
  capabilities: BUILDER_CAPABILITIES,
  outputSchema: BUILD_TURN_SCHEMA,
  prepare: (db, order, { dir, env, checkSandbox, returned }) => {
    const plan = latestApprovedPlan(db, order.id);
    if (!plan) throw new Error(`order ${order.id} has no approved plan to build`);
    const currentSlice = nextOrderSlice(db, order.id);
    const conflict = currentSlice ? null : pendingRebaseConflict(db, order.id);
    const reviewFindings =
      currentSlice || conflict ? NO_REVIEW_FINDINGS : reviewFindingsForBuild(db, order.id);
    const previousFailure = db
      .query<{ reason: string | null }, [string]>(
        `SELECT reason FROM factory_order_attempt
         WHERE order_id = ? AND station = 'build' AND kind = 'finished'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(order.id);
    const root = repoRoot(dir);
    const worktree = worktreePath(root, order.id);
    const undone = undoInterruptedJudgement(db, order.id, worktree);
    if (undone) writeTrace(db, { event: "order.judgement_undone", orderId: order.id, name: undone });
    const workspace = workspaceContract(worktree);
    const rebase = conflict ? { conflict, paths: reopenRebase(worktree, order.id, conflict) } : null;
    return {
      cwd: worktree,
      brief: builderBrief(
        order,
        plan,
        currentSlice,
        workspace,
        returned ? { body: returned.body, feedback: returned.reason } : undefined,
        previousFailure?.reason ?? undefined,
        reviewFindings,
        rebase ? undefined : checkoutConvention(db, root),
        rebase?.paths ?? null,
        failedHeadCheck(db, order.id),
      ),
      context: {
        line: order.line,
        finalOrdinal: plan.slices.length,
        currentSlice,
        rebase,
        owed: reviewFindings.work.map((one) => one.finding),
        priorBuild: latestArtifact(db, order.id, "build")?.id ?? 0,
        worktree,
        env,
        checkSandbox,
      },
    };
  },
  accept: async (db, output, turn, context) => {
    if (context.rebase) {
      await resolveRebase(db, turn, context, context.rebase);
    } else {
      await commitSlice(db, output, turn, context);
      if (context.currentSlice) completeOrderSlice(db, turn.orderId, context.currentSlice.id, turn.worker);
      else completeOrderBuildFollowup(db, turn.orderId, context.priorBuild);
    }
    return { builder: turn.worker, runId: turn.runId, worktree: context.worktree };
  },
};
