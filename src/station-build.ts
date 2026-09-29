import type { Database } from "bun:sqlite";
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
import { fail } from "./station-contract";
import { stationDirectory } from "./station-directory";
import type { PlanSlice } from "./station-plan-artifact";
import { writeTrace } from "./trace-store";
import type { Capability } from "./worker-capabilities";
import { type WorkspaceContract, workspaceContract } from "./workspace";

export const BUILDER_CAPABILITIES: Capability[] = [
  "bootstrap-worker",
  "read-files",
  "edit-files",
  "read-history",
  "ask-dim",
  "run-check",
];

export type BriefedWorkspace = Pick<
  WorkspaceContract,
  "ecosystems" | "packageManagers" | "checkTask" | "formatTask" | "tasks"
>;

function workspaceLines(workspace: BriefedWorkspace): string[] {
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

export type BuildBriefing = {
  plan: { body: string; slices: readonly PlanSlice[] };
  currentSlice: OrderSlice | null;
  workspace: BriefedWorkspace;
  revision?: { body: string; feedback: string };
  previousFailure?: string;
  reviewFindings?: ReviewFindingsForBuild;
  conflicts?: readonly string[];
  redCheck?: FailedCheck | null;
};

export function builderBrief(order: BriefedOrder, briefing: BuildBriefing): string {
  const { plan, currentSlice, workspace, revision, previousFailure, conflicts, redCheck } = briefing;
  const reviewFindings = briefing.reviewFindings ?? NO_REVIEW_FINDINGS;
  const resolving = conflicts !== undefined;
  return [
    ...briefHeader("builder", "dim-build", order, !resolving),
    "",
    "## Workspace",
    ...workspaceLines(workspace),
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
    const worktree = stationDirectory(dir, order.id);
    const undone = undoInterruptedJudgement(db, order.id, worktree);
    if (undone) writeTrace(db, { event: "order.judgement_undone", orderId: order.id, name: undone });
    const workspace = workspaceContract(worktree);
    if (workspace === null) throw fail("worktree_not_checkout", { orderId: order.id, worktree });
    const rebase = conflict ? { conflict, paths: reopenRebase(worktree, order.id, conflict) } : null;
    return {
      cwd: worktree,
      brief: builderBrief(order, {
        plan,
        currentSlice,
        workspace,
        revision: returned ? { body: returned.body, feedback: returned.reason } : undefined,
        previousFailure: previousFailure?.reason ?? undefined,
        reviewFindings,
        conflicts: rebase?.paths,
        redCheck: failedHeadCheck(db, order.id),
      }),
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
