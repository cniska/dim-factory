import type { Database } from "bun:sqlite";
import { assertOperator } from "./factory-operator";
import { type CheckoutConvention, CONVENTION_FLOOR, checkoutConvention } from "./git-commit-convention";
import type { HarnessAdapter } from "./harness";
import { workerFailureReason } from "./harness-launch";
import type { HarnessName } from "./harness-name";
import { latestApprovedPlan } from "./order-approved-plan";
import {
  completeOrderBuildFollowup,
  completeOrderSlice,
  latestArtifact,
  nextOrderSlice,
  type OrderSlice,
} from "./order-artifacts";
import { assertNoRunningAttempt, openAttempt } from "./order-attempt";
import { latestOrderCommit, pendingRebaseConflict } from "./order-commits";
import { BuildTurnRefused } from "./order-finding";
import { type FindingStanding, orderFindingStandings, owesAnswer } from "./order-finding-state";
import { assertChecked, type FailedCheck, failedHeadCheck } from "./order-head-check";
import { appendOrderEvent } from "./order-ledger";
import { assertNext } from "./order-state";
import { orderStatus } from "./order-status";
import type { Env } from "./paths";
import { startStationAttempt } from "./station-attempt";
import { type BriefedOrder, briefHeader } from "./station-brief";
import { commitBuildTurn } from "./station-build-commit";
import { settlePinnedSlice } from "./station-build-proof";
import { continueRebaseTurn, reopenRebase } from "./station-build-rebase";
import { BUILD_TURN_SCHEMA, parseBuildTurn } from "./station-build-turn";
import type { PlanSlice } from "./station-plan-artifact";
import {
  assertOrderWorkerHarness,
  orderWorkerIsBound,
  resumeOrderStationLive,
  runOrderStationLive,
  UsageLimited,
} from "./station-worker";
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
      : `The runner's check passed, and its commit of your worktree with the subject \`${subject}\` was refused:`,
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

export type BuildOutcome = { builder: string; runId: string; worktree: string; exitCode: number };

function requireBuildEvidence(db: Database, orderId: string, finalSlice: boolean, worktree: string): void {
  const commit = latestOrderCommit(db, orderId);
  if (!commit) throw new Error("builder did not record a commit");
  if (!/^[0-9a-fA-F]{7,64}$/.test(commit.sha)) {
    throw new Error(`builder did not record an immutable commit ID for ${orderId}`);
  }
  const head = Bun.spawnSync(["git", "-C", worktree, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!head.success) throw new Error(`cannot read worktree HEAD for ${orderId}`);
  if (!head.stdout.toString().trim().startsWith(commit.sha.toLowerCase())) {
    throw new Error(`builder did not record worktree HEAD for ${orderId}`);
  }
  assertChecked(db, orderId);
  if (finalSlice) {
    const build = db
      .query<{ id: number }, [string, string]>(
        "SELECT id FROM factory_order_artifact WHERE order_id = ? AND kind = 'build' AND head_sha = ? ORDER BY revision DESC LIMIT 1",
      )
      .get(orderId, commit.sha);
    if (!build) throw new Error("builder did not record a Build artifact for the completed order");
  }
}

export async function runOrderBuildLive(
  db: Database,
  orderId: string,
  operator: string,
  options: {
    dir: string;
    env?: Env;
    harness: HarnessName;
    adapter?: HarnessAdapter;
    checkSandbox?: string[];
  },
): Promise<BuildOutcome> {
  const order = db
    .query<BriefedOrder, [string]>("SELECT id, title, description, line FROM factory_order WHERE id = ?")
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  assertOperator(db, operator, "delegate build");
  assertNext(db, orderId, "build");
  assertNoRunningAttempt(db, orderId, "start a builder");
  const plan = latestApprovedPlan(db, orderId);
  if (!plan) throw new Error(`order ${orderId} has no approved plan to build`);
  const { harness } = options;
  assertOrderWorkerHarness(db, orderId, "builder", harness);
  const { slices } = plan;
  const currentSlice = nextOrderSlice(db, orderId);
  const conflict = currentSlice ? null : pendingRebaseConflict(db, orderId);
  const reviewFindings = currentSlice || conflict ? NO_REVIEW_FINDINGS : reviewFindingsForBuild(db, orderId);
  const redCheck = failedHeadCheck(db, orderId);
  const priorBuild = latestArtifact(db, orderId, "build")?.id ?? 0;
  const previousFailure = db
    .query<{ reason: string | null }, [string]>(
      `SELECT reason FROM factory_order_attempt
       WHERE order_id = ? AND station = 'build' AND kind = 'finished'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(orderId);
  const runId = `build-${crypto.randomUUID()}`;
  const root = repoRoot(options.dir);
  const worktree = worktreePath(root, orderId);
  const pinned = settlePinnedSlice(worktree, orderId);
  if (pinned) {
    const event = pinned.restored ? "order.proof_pin_restored" : "order.proof_pin_dropped";
    writeTrace(db, { event, orderId, name: pinned.pin });
  }
  const workspace = workspaceContract(worktree);
  const convention = conflict ? undefined : checkoutConvention(db, root);
  let builder: string | undefined;
  let harnessOutput = "";
  let harnessFailureReason: string | undefined;
  let failureRecorded = false;
  let claimed = false;
  const recordFailure = (reason: string): void => {
    if (failureRecorded || orderStatus(db, orderId) !== "running") return;
    if (claimed && openAttempt(db, orderId)?.runId !== runId) return;
    failureRecorded = true;
    const turn = orderWorkerIsBound(db, orderId, "builder", builder);
    appendOrderEvent(db, orderId, {
      kind: "failed",
      station: "build",
      worker: claimed ? builder : undefined,
      reason,
      evidence: { turn },
    });
  };
  try {
    const conflicts = conflict ? reopenRebase(worktree, orderId, conflict) : null;
    const onAssigned = (
      assigned: string,
      providerSessionId: string,
      attribution: { harness: string; model: string; tier: string },
    ): void => {
      builder = assigned;
      startStationAttempt(
        db,
        orderId,
        {
          runId,
          worker: assigned,
          sessionId: providerSessionId,
          providerSessionId,
          station: "build",
          operatorWorker: operator,
          ...attribution,
        },
        new Date().toISOString(),
      );
      claimed = true;
    };
    const { run, worker: assigned } = await runOrderStationLive({
      db,
      orderId,
      station: "build",
      parentWorker: operator,
      harness,
      env: options.env,
      adapter: options.adapter,
      onPrepared: (orderWorker) => {
        builder = orderWorker.worker;
      },
      onAssigned,
      request: ({ returned: artifact }) => ({
        cwd: worktree,
        brief: builderBrief(
          order,
          plan,
          currentSlice,
          workspace,
          artifact ? { body: artifact.body, feedback: artifact.reason } : undefined,
          previousFailure?.reason ?? undefined,
          reviewFindings,
          convention,
          conflicts,
          redCheck,
        ),
        capabilities: BUILDER_CAPABILITIES,
        outputSchema: BUILD_TURN_SCHEMA,
      }),
    });
    const finished = (turn: typeof run): string => {
      harnessOutput = turn.output;
      harnessFailureReason = turn.failureReason;
      if (turn.exitCode !== 0) {
        throw new Error(
          turn.harnessExitCode === undefined
            ? `${builder} did not finish`
            : `${builder} exited with code ${turn.harnessExitCode}`,
        );
      }
      return turn.output;
    };
    harnessOutput = run.output;
    harnessFailureReason = run.failureReason;
    builder = assigned;
    if (!builder) throw new Error("builder did not bootstrap its worker assignment");
    let output = finished(run);
    for (let paths = conflicts; conflict && paths; ) {
      const continued = continueRebaseTurn({
        db,
        orderId,
        worktree,
        conflict,
        paths,
        env: options.env,
        checkSandbox: options.checkSandbox,
      });
      if ("sha" in continued) break;
      paths = continued.conflicts;
      finished(
        await resumeOrderStationLive({
          db,
          orderId,
          station: "build",
          harness,
          env: options.env,
          adapter: options.adapter,
          request: {
            cwd: worktree,
            brief: conflictLines(paths).join("\n"),
            capabilities: BUILDER_CAPABILITIES,
            outputSchema: BUILD_TURN_SCHEMA,
          },
        }),
      );
    }
    for (let corrections = 0; !conflict; corrections++) {
      const turn = parseBuildTurn(output.trim());
      try {
        commitBuildTurn({
          db,
          orderId,
          runId,
          builder,
          worktree,
          turn,
          owed: reviewFindings.work.map((one) => one.finding),
          finalSlice: currentSlice === null || currentSlice.ordinal === slices.length,
          proofRequired: order.line === "fix" && currentSlice !== null,
          env: options.env,
          checkSandbox: options.checkSandbox,
        });
        break;
      } catch (error) {
        if (
          !(error instanceof BuildTurnRefused) ||
          !["commit_refused", "comment_added", "attributes_changed"].includes(error.code) ||
          corrections === COMMIT_CORRECTIONS
        ) {
          throw error;
        }
        output = finished(
          await resumeOrderStationLive({
            db,
            orderId,
            station: "build",
            harness,
            env: options.env,
            adapter: options.adapter,
            request: {
              cwd: worktree,
              brief: commitCorrectionBrief(turn.subject, error),
              capabilities: BUILDER_CAPABILITIES,
              outputSchema: BUILD_TURN_SCHEMA,
            },
          }),
        );
      }
    }
    if (currentSlice) {
      requireBuildEvidence(db, orderId, currentSlice.ordinal === slices.length, worktree);
      completeOrderSlice(db, orderId, currentSlice.id, builder);
    } else if (!conflict) {
      requireBuildEvidence(db, orderId, true, worktree);
      completeOrderBuildFollowup(db, orderId, priorBuild);
    }
    return { builder, runId, worktree, exitCode: run.exitCode };
  } catch (error) {
    const reason = workerFailureReason(
      error instanceof Error ? error.message : String(error),
      harnessOutput,
      harnessFailureReason,
    );
    recordFailure(reason);
    if (error instanceof UsageLimited) throw error;
    throw new Error(reason, { cause: error });
  }
}
