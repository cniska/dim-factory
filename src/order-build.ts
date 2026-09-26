import type { Database } from "bun:sqlite";
import { BUILD_TURN_SCHEMA, parseBuildTurn } from "./build-turn";
import { BuildTurnRefused, commitBuildTurn } from "./builder-commit";
import type { Capability } from "./capabilities";
import { type CheckoutConvention, CONVENTION_FLOOR, checkoutConvention } from "./commit-convention";
import { assertOperator } from "./factory-operator";
import type { OrderSlice } from "./factory-order";
import {
  appendOrderEvent,
  claimOrder,
  completeOrderBuildFollowup,
  completeOrderSlice,
  isActiveOrderRun,
  latestOrderCommit,
  nextOrderSlice,
  OrderNotDone,
  orderStatus,
  PlanApprovalRefused,
} from "./factory-order";
import type { HarnessAdapter } from "./harness";
import { workerFailureReason } from "./harness-command";
import { DEFAULT_HARNESS, type HarnessName } from "./harness-name";
import { assertOrderWorkerHarness, resumeOrderStationLive, runOrderStationLive } from "./order-worker";
import type { Env } from "./paths";
import type { PlanSlice } from "./plan-artifact";
import { workspaceContract } from "./workspace";
import { repoRoot, worktreePath } from "./wt-command";

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
    return `The record holds ${commits} commits from ${repo}, fewer than the ${CONVENTION_FLOOR} it takes to read a convention from; take the subject's form from the repository's own git log.`;
  }
  const kinds = observed.topKinds.length > 0 ? `, most often ${observed.topKinds.join(", ")}` : "";
  return [
    `The record holds ${commits} commits from ${repo}. ${observed.conventionalPct}% of their subjects carry a Conventional Commits type${kinds}; subjects average ${observed.meanLength} characters and ${observed.over50Pct}% run over 50.`,
    "This is what the log shows, not a limit: the repository's commit hooks decide what git accepts, and a commit git refuses comes back to you with its reason.",
  ].join(" ");
}

export function builderBrief(
  order: { id: string; title: string; description: string | null },
  plan: { body: string; slices: readonly PlanSlice[] },
  currentSlice: OrderSlice | null,
  workspace: ReturnType<typeof workspaceContract>,
  revision?: { body: string; feedback: string },
  previousFailure?: string,
  reviewFindings: readonly string[] = [],
  convention?: CheckoutConvention,
): string {
  const needsCodeWork = currentSlice !== null || reviewFindings.length > 0;
  const workspaceContext = workspace
    ? [
        `Workspace ecosystem: ${workspace.ecosystems.join(", ") || "unknown"}.`,
        `Workspace package managers: ${workspace.packageManagers.join(", ") || "none declared"}.`,
        `Declared check: ${workspace.checkCommand?.command ?? "none"}.`,
        `Declared format: ${workspace.formatCommand?.command ?? "none"}.`,
        `Workspace commands: ${workspace.commands.map((one) => `${one.name}=${one.command} (${one.source})`).join("; ") || "none"}.`,
        "Replace $FILES in a workspace command with the changed paths when the command is scoped.",
        "Use these workspace commands; do not infer a different project tool.",
      ]
    : ["The workspace profile could not be read; stop and report that before editing."];
  return [
    `You are the builder for factory order ${order.id} in this repository.`,
    "",
    `# ${order.title}`,
    order.description ?? "",
    "",
    "# Workspace",
    ...workspaceContext,
    "",
    ...(needsCodeWork && convention ? ["# Commit convention", conventionContext(convention), ""] : []),
    "The operator approved the following plan. Implement only this outcome:",
    "",
    plan.body,
    "",
    ...(currentSlice
      ? ["# Current slice", `${currentSlice.ordinal}. ${currentSlice.title}: ${currentSlice.outcome}`]
      : []),
    ...(revision
      ? ["# Returned Build artifact", revision.body, "", "# Owner feedback", revision.feedback]
      : []),
    ...(reviewFindings.length > 0 ? ["# Review findings", ...reviewFindings.map((one) => `- ${one}`)] : []),
    ...(needsCodeWork && previousFailure
      ? [
          "# Previous failed Build attempt",
          previousFailure,
          "Continue from this feedback and leave the worktree passing the declared check before ending the turn.",
        ]
      : []),
    "",
    "# Ordered slices",
    ...plan.slices.map((slice, index) => `${index + 1}. ${slice.title}: ${slice.outcome}`),
    "",
    needsCodeWork
      ? "The factory runner has already claimed this order for this build turn under your worker identity."
      : "The owner returned the Build artifact to you. The code work is complete; revise only the artifact.",
    needsCodeWork
      ? "Work in the current order worktree and run the build station loop including simplification. Record each document and build finding with dim order."
      : "Do not edit files or create commits. Use the order record to correct the returned Build artifact for the latest recorded order commit.",
    "The factory has already accepted your assignment before this turn starts. Do not register or bootstrap another worker, inspect worker credential files, or stop because DIM_WORKER_NAME and DIM_WORKER_TOKEN are absent; order commands authenticate this assigned process through its DIM_WORKER_ASSIGNMENT variables.",
    "The order description and approved plan define the scope. When they explicitly exclude a workspace surface, do not edit or test that surface.",
    ...(needsCodeWork
      ? [
          "Leave every change uncommitted in the worktree. Do not run git commit, git stash, or any command that rewrites history. When the turn ends, the factory runner runs the declared check in a sandbox, commits the worktree with the repository's own git identity and signing config, and records the commit and its files under you and the check under the operator. Stay on the order's branch and do not create a git repository inside the worktree; the runner refuses both.",
          "You may run the declared check yourself as feedback. A red check is feedback, not completion: diagnose it, fix the cause, rerun the check, and continue until it passes. If the cause is genuinely blocked, report the blocker instead of claiming success.",
          "Do not run dim order stop: the factory runner records this attempt and makes the order retryable when the turn fails.",
          'End the turn by returning JSON `{"subject": "...", "artifact": "..."}`. `subject` is the commit subject, in the repo\'s own commit convention. `artifact` is the Build artifact for the whole order when this turn finishes the final slice or answers review findings, and an empty string otherwise. Use dim-station-build and dim-artifact for the artifact contract: separate Markdown headings, the result explained for the owner rather than the command transcript, and proportional to the change.',
        ]
      : [
          "Structure the returned artifact with separate Markdown headings: Outcome, Implementation, Why this shape, Verification, and Owner attention. Keep each section concise and include only claims supported by the order record.",
          `Record a new Build artifact revision with \`dim order build-artifact ${order.id} --body "..." --head <latest-commit-sha>\`.`,
        ]),
    `${needsCodeWork ? "" : "Return a concise outcome. "}Do not approve the plan or build, start review, ship, or edit outside the order worktree.`,
  ].join("\n");
}

/** How many times one build turn's builder is resumed to answer a commit git refused. */
const COMMIT_CORRECTIONS = 2;

export function commitCorrectionBrief(subject: string, refusal: string): string {
  return [
    "# Commit refused",
    `The runner's check passed, and its commit of your worktree with the subject \`${subject}\` was refused:`,
    "",
    refusal,
    "",
    "This is feedback within the current Build attempt: the order is still claimed by this turn and your changes are still uncommitted in the worktree.",
    "Answer the refusal, leaving every change uncommitted. When the turn ends, the runner reruns the declared check and commits again.",
    'Return the complete JSON `{"subject": "...", "artifact": "..."}` again, carrying the same artifact the turn owes.',
  ].join("\n");
}

function reviewFindingsForBuild(db: Database, orderId: string): string[] {
  const review = db
    .query<{ id: number; event_id: number | null; outcome: string | null }, [string]>(
      `SELECT r.id, r.outcome, e.id AS event_id
       FROM factory_order_review r
       LEFT JOIN factory_order_event e ON e.review_id = r.id AND e.kind = 'review_closed'
       WHERE r.order_id = ?
       ORDER BY r.round DESC LIMIT 1`,
    )
    .get(orderId);
  if (review?.outcome !== "closed" || review.event_id === null) return [];
  if (
    db
      .query(
        "SELECT 1 FROM factory_order_event WHERE order_id = ? AND kind = 'build_artifact_written' AND id > ?",
      )
      .get(orderId, review.event_id)
  ) {
    return [];
  }
  const findings = db
    .query<{ summary: string; answer: string | null }, [number]>(
      "SELECT summary, answer FROM factory_order_finding WHERE review_id = ? ORDER BY id",
    )
    .all(review.id);
  if (findings.some((finding) => finding.answer === null)) {
    throw new Error(`order ${orderId} has unanswered review findings`);
  }
  return findings.map((finding) => finding.summary);
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
  // Only a check the runner ran counts: a builder reporting its own check is reporting on code
  // it wrote, from inside the sandbox that code ran in.
  const check = db
    .query<{ exit_code: number }, [string]>(
      `SELECT c.exit_code FROM factory_order_check c
       JOIN factory_order_event check_event
         ON check_event.order_id = c.order_id AND check_event.check_id = c.id AND check_event.kind = 'check_finished'
       JOIN factory_worker w ON w.name = check_event.worker AND w.role = 'operator'
       WHERE c.order_id = ? AND check_event.id > coalesce((
         SELECT max(commit_event.id) FROM factory_order_event commit_event
         WHERE commit_event.order_id = c.order_id AND commit_event.kind = 'commit_created'
       ), 0)
       ORDER BY check_event.id DESC LIMIT 1`,
    )
    .get(orderId);
  if (check?.exit_code !== 0)
    throw new Error("the runner did not record a passing check after the latest commit");
  if (finalSlice) {
    const build = db
      .query<{ id: number }, [string, string]>(
        "SELECT id FROM factory_order_build WHERE order_id = ? AND head_sha = ? ORDER BY revision DESC LIMIT 1",
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
    harness?: HarnessName;
    adapter?: HarnessAdapter;
    checkSandbox?: string[];
  },
): Promise<BuildOutcome> {
  const order = db
    .query<{ id: string; title: string; description: string | null }, [string]>(
      "SELECT id, title, description FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  assertOperator(db, operator, "delegate build");
  const state = db
    .query<{ station: string | null; run_id: string | null }, [string]>(
      "SELECT station, run_id FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  if (state?.station !== "build" && state?.station !== "dim-station-build") {
    throw new OrderNotDone(
      "order_not_building",
      `order ${orderId} must be at build before a builder can start`,
    );
  }
  if (state.run_id !== null) {
    throw new OrderNotDone("order_held_by_run", `order ${orderId} is already held by a run`);
  }
  const plan = db
    .query<{ id: number; body: string }, [string]>(
      `SELECT p.id, p.body FROM factory_order_plan p
       WHERE p.order_id = ? AND EXISTS (
         SELECT 1 FROM factory_order_event e
         WHERE e.order_id = p.order_id AND e.kind = 'plan_approved' AND e.plan_id = p.id
       )
       ORDER BY p.revision DESC, p.id DESC LIMIT 1`,
    )
    .get(orderId);
  if (!plan) throw new PlanApprovalRefused("plan_missing", `order ${orderId} has no approved plan to build`);
  const harness = options.harness ?? DEFAULT_HARNESS;
  assertOrderWorkerHarness(db, orderId, "builder", harness);
  const slices = db
    .query<PlanSlice, [number]>(
      "SELECT title, outcome FROM factory_order_slice WHERE plan_id = ? ORDER BY ordinal",
    )
    .all(plan.id);
  const currentSlice = nextOrderSlice(db, orderId);
  const reviewFindings = currentSlice ? [] : reviewFindingsForBuild(db, orderId);
  const needsCodeWork = currentSlice !== null || reviewFindings.length > 0;
  const previousFailure = db
    .query<{ reason: string | null }, [string]>(
      `SELECT reason FROM factory_order_attempt
       WHERE order_id = ? AND station = 'dim-station-build' AND kind = 'finished'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(orderId);
  const runId = `build-${crypto.randomUUID()}`;
  const root = repoRoot(options.dir);
  const worktree = worktreePath(root, orderId);
  const workspace = workspaceContract(worktree);
  const convention = needsCodeWork ? checkoutConvention(db, root) : undefined;
  let builder: string | undefined;
  let harnessOutput = "";
  let harnessFailureReason: string | undefined;
  let failureRecorded = false;
  let claimed = false;
  const recordFailure = (reason: string): void => {
    if (!needsCodeWork || failureRecorded || orderStatus(db, orderId) !== "working") return;
    if (claimed && !isActiveOrderRun(db, orderId, runId)) return;
    failureRecorded = true;
    appendOrderEvent(db, orderId, { kind: "failed", worker: builder, reason });
  };
  try {
    const onAssigned = (
      assigned: string,
      providerSessionId: string,
      attribution: { harness: string; model: string; tier: string },
    ): void => {
      builder = assigned;
      if (needsCodeWork) {
        claimOrder(
          db,
          orderId,
          {
            runId,
            sessionId: providerSessionId,
            providerSessionId,
            station: "dim-station-build",
            operatorWorker: operator,
            ...attribution,
          },
          builder,
          undefined,
          worktree,
        );
        claimed = true;
      }
    };
    const {
      run,
      worker: assigned,
      returned,
    } = await runOrderStationLive({
      db,
      orderId,
      station: "build",
      parentWorker: operator,
      harness,
      env: options.env,
      adapter: options.adapter,
      requireReturnedArtifact: !needsCodeWork,
      onPrepared: (orderWorker) => {
        builder = orderWorker.worker;
      },
      onAssigned,
      request: ({ returned: artifact }) => ({
        cwd: worktree,
        brief: builderBrief(
          order,
          { body: plan.body, slices },
          currentSlice,
          workspace,
          artifact ? { body: artifact.body, feedback: artifact.reason } : undefined,
          previousFailure?.reason ?? undefined,
          reviewFindings,
          convention,
        ),
        capabilities: BUILDER_CAPABILITIES,
        ...(needsCodeWork ? { outputSchema: BUILD_TURN_SCHEMA } : {}),
      }),
    });
    const finished = (turn: typeof run): string => {
      harnessOutput = turn.output;
      harnessFailureReason = turn.failureReason;
      if (turn.exitCode === 0) return turn.output;
      throw new Error(
        turn.harnessExitCode === undefined
          ? `${builder} did not finish`
          : `${builder} exited with code ${turn.harnessExitCode}`,
      );
    };
    harnessOutput = run.output;
    harnessFailureReason = run.failureReason;
    builder = assigned;
    if (!builder) throw new Error("builder did not bootstrap its worker assignment");
    let output = finished(run);
    for (let corrections = 0; needsCodeWork; corrections++) {
      const turn = parseBuildTurn(output.trim());
      try {
        commitBuildTurn({
          db,
          orderId,
          runId,
          builder,
          operator,
          worktree,
          turn,
          finalSlice: currentSlice === null || currentSlice.ordinal === slices.length,
          env: options.env,
          checkSandbox: options.checkSandbox,
        });
        break;
      } catch (error) {
        if (
          !(error instanceof BuildTurnRefused) ||
          error.code !== "commit_refused" ||
          corrections === COMMIT_CORRECTIONS ||
          !isActiveOrderRun(db, orderId, runId)
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
              brief: commitCorrectionBrief(turn.subject, error.message),
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
    } else if (reviewFindings.length > 0) {
      requireBuildEvidence(db, orderId, true, worktree);
      completeOrderBuildFollowup(db, orderId, builder);
    } else {
      const revision = db
        .query<{ id: number; worker: string }, [string]>(
          "SELECT id, worker FROM factory_order_build WHERE order_id = ? ORDER BY revision DESC LIMIT 1",
        )
        .get(orderId);
      if (!revision || revision.id === returned?.buildId || revision.worker !== builder) {
        throw new Error("builder did not record a new Build artifact revision");
      }
      requireBuildEvidence(db, orderId, true, worktree);
    }
    return { builder, runId, worktree, exitCode: run.exitCode };
  } catch (error) {
    const reason = workerFailureReason(
      error instanceof Error ? error.message : String(error),
      harnessOutput,
      harnessFailureReason,
    );
    recordFailure(reason);
    throw new Error(reason, { cause: error });
  }
}
