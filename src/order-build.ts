import type { Database } from "bun:sqlite";
import type { Capability } from "./capabilities";
import { assertOperator } from "./factory-operator";
import type { OrderSlice } from "./factory-order";
import {
  appendOrderEvent,
  claimOrder,
  completeOrderSlice,
  isActiveOrderRun,
  isTerminalOrderStatus,
  nextOrderSlice,
  OrderNotDone,
  orderStatus,
  PlanApprovalRefused,
} from "./factory-order";
import type { HarnessAdapter } from "./harness";
import { workerFailureReason } from "./harness-command";
import type { HarnessName } from "./harness-name";
import { runOrderStation, runOrderStationLive } from "./order-worker";
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

export type BuilderSpawn = (argv: string[], env: Record<string, string>, cwd: string) => { exitCode: number };

export function builderBrief(
  order: { id: string; title: string; description: string | null },
  plan: { body: string; slices: readonly PlanSlice[] },
  currentSlice: OrderSlice | null,
  workspace: ReturnType<typeof workspaceContract>,
  revision?: { body: string; feedback: string },
): string {
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
    "The operator approved the following plan. Implement only this outcome:",
    "",
    plan.body,
    "",
    ...(currentSlice
      ? ["# Current slice", `${currentSlice.ordinal}. ${currentSlice.title}: ${currentSlice.outcome}`]
      : [
          "# Returned Build artifact",
          revision?.body ?? "",
          "",
          "# Owner feedback",
          revision?.feedback ?? "",
        ]),
    "",
    "# Ordered slices",
    ...plan.slices.map((slice, index) => `${index + 1}. ${slice.title}: ${slice.outcome}`),
    "",
    currentSlice
      ? "The factory runner has already claimed this order for this build turn under your worker identity."
      : "The owner returned the Build artifact to you. The code work is complete; revise only the artifact.",
    currentSlice
      ? "Work in the current order worktree. Run the command supplied by the workspace profile, record every commit, changed file, check, document, and build finding with dim order, and run the build station loop including simplification."
      : "Do not edit files, create commits, or run checks. Use the order record to correct the returned Build artifact.",
    "The factory has already accepted your assignment before this turn starts. Do not register or bootstrap another worker, inspect worker credential files, or stop because DIM_WORKER_NAME and DIM_WORKER_TOKEN are absent; order commands authenticate this assigned process through its DIM_WORKER_ASSIGNMENT variables.",
    "The order description and approved plan define the scope. When they explicitly exclude a workspace surface, do not edit or test that surface; record a passing check scoped to the requested result instead of treating excluded failures as blockers.",
    ...(currentSlice
      ? [
          "A red check is feedback, not completion: diagnose it, fix the cause, rerun the check, and continue until the final commit has a passing check. If the cause is genuinely blocked, report the blocker instead of claiming success.",
          "Do not run dim order stop: the factory runner records this attempt and makes the order retryable when the turn fails.",
          `After the passing check, record the commit with \`dim order commit ${order.id} --sha <latest-commit-sha> --subject "..."\`, record each changed path with \`dim order file ${order.id} --path <path>\`, and record the check with \`dim order check ${order.id} --command "<workspace check>" --exit 0 --result "green"\`. After the final slice, record one Build artifact for the whole order with \`dim order build-artifact ${order.id} --body "..." --head <latest-commit-sha>\`. Use dim-station-build and dim-artifact for the artifact contract: explain the result for the owner, not the command transcript, and keep it proportional to the change.`,
        ]
      : [
          "Structure the returned artifact with separate Markdown headings: Outcome, Implementation, Why this shape, Verification, and Owner attention. Keep each section concise and include only claims supported by the order record.",
          `Record a new Build artifact revision with \`dim order build-artifact ${order.id} --body "..." --head <latest-commit-sha>\`.`,
        ]),
    "Return a concise outcome. Do not approve the plan or build, start review, ship, or edit outside the order worktree.",
  ].join("\n");
}

export type BuildOutcome = { builder: string; runId: string; worktree: string; exitCode: number };

function requireBuildEvidence(db: Database, orderId: string, finalSlice: boolean): void {
  const commit = db
    .query<{ sha: string; recorded_at: string }, [string]>(
      "SELECT sha, recorded_at FROM factory_order_commit WHERE order_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1",
    )
    .get(orderId);
  if (!commit) throw new Error("builder did not record a commit");
  const check = db
    .query<{ exit_code: number }, [string]>(
      "SELECT exit_code FROM factory_order_check WHERE order_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1",
    )
    .get(orderId);
  if (check?.exit_code !== 0) throw new Error("builder did not record a passing check");
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
  options: { dir: string; env?: Env; harness?: HarnessName; adapter?: HarnessAdapter },
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
  const slices = db
    .query<PlanSlice, [number]>(
      "SELECT title, outcome FROM factory_order_slice WHERE plan_id = ? ORDER BY ordinal",
    )
    .all(plan.id);
  const currentSlice = nextOrderSlice(db, orderId);
  const runId = `build-${crypto.randomUUID()}`;
  const worktree = worktreePath(repoRoot(options.dir), orderId);
  const workspace = workspaceContract(worktree);
  let builder: string | undefined;
  let harnessOutput = "";
  let harnessFailureReason: string | undefined;
  let failureRecorded = false;
  let claimed = false;
  const recordFailure = (reason: string): void => {
    if (!currentSlice || failureRecorded || isTerminalOrderStatus(orderStatus(db, orderId))) return;
    if (claimed && !isActiveOrderRun(db, orderId, runId)) return;
    failureRecorded = true;
    appendOrderEvent(db, orderId, { kind: "failed", worker: builder, reason });
  };
  try {
    const harness = options.harness ?? "codex";
    const onAssigned = (assigned: string, providerSessionId: string): void => {
      builder = assigned;
      if (currentSlice) {
        claimOrder(
          db,
          orderId,
          {
            runId,
            sessionId: providerSessionId,
            station: "dim-station-build",
            operatorWorker: operator,
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
      useReturnedArtifact: currentSlice === null,
      requireReturnedArtifact: currentSlice === null,
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
        ),
        capabilities: BUILDER_CAPABILITIES,
      }),
    });
    harnessOutput = run.output;
    harnessFailureReason = run.failureReason;
    builder = assigned;
    if (!builder) throw new Error("builder did not bootstrap its worker assignment");
    if (run.exitCode !== 0) {
      throw new Error(`${builder} exited with code ${run.exitCode}`);
    }
    if (currentSlice) {
      requireBuildEvidence(db, orderId, currentSlice.ordinal === slices.length);
      completeOrderSlice(db, orderId, currentSlice.id, builder);
    } else {
      const revision = db
        .query<{ id: number; worker: string }, [string]>(
          "SELECT id, worker FROM factory_order_build WHERE order_id = ? ORDER BY revision DESC LIMIT 1",
        )
        .get(orderId);
      if (!revision || revision.id === returned?.buildId || revision.worker !== builder) {
        throw new Error("builder did not record a new Build artifact revision");
      }
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

export function runOrderBuild(
  db: Database,
  orderId: string,
  operator: string,
  options: { dir: string; env?: Env; spawn?: BuilderSpawn; harness?: HarnessName },
): BuildOutcome {
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
  if (!plan) {
    throw new PlanApprovalRefused("plan_missing", `order ${orderId} has no approved plan to build`);
  }
  const slices = db
    .query<PlanSlice, [number]>(
      "SELECT title, outcome FROM factory_order_slice WHERE plan_id = ? ORDER BY ordinal",
    )
    .all(plan.id);
  const currentSlice = nextOrderSlice(db, orderId);
  const runId = `build-${crypto.randomUUID()}`;
  const worktree = worktreePath(repoRoot(options.dir), orderId);
  const workspace = workspaceContract(worktree);
  let builder: string | undefined;
  let failureRecorded = false;
  const recordFailure = (reason: string): void => {
    if (!currentSlice || failureRecorded || isTerminalOrderStatus(orderStatus(db, orderId))) return;
    failureRecorded = true;
    appendOrderEvent(db, orderId, {
      kind: "failed",
      worker: builder,
      reason,
    });
  };
  try {
    const harness = options.harness ?? "codex";
    const { run, worker, returned } = runOrderStation({
      db,
      orderId,
      station: "build",
      parentWorker: operator,
      harness,
      env: options.env,
      useReturnedArtifact: currentSlice === null,
      requireReturnedArtifact: currentSlice === null,
      spawn: options.spawn
        ? (argv, env) => {
            const result = options.spawn?.(argv, env, worktree);
            if (!result) throw new Error("builder spawn was not provided");
            return { exitCode: result.exitCode, output: "" };
          }
        : undefined,
      request: ({ returned: artifact }) => ({
        cwd: worktree,
        brief: builderBrief(
          order,
          { body: plan.body, slices },
          currentSlice,
          workspace,
          artifact ? { body: artifact.body, feedback: artifact.reason } : undefined,
        ),
        capabilities: BUILDER_CAPABILITIES,
      }),
    });
    builder = worker;
    if (!builder) throw new Error("builder did not bootstrap its worker assignment");
    if (run.exitCode !== 0) {
      const reason = `${builder} exited with code ${run.exitCode}`;
      recordFailure(reason);
      throw new Error(`${builder} did not finish building`);
    }
    if (currentSlice) {
      requireBuildEvidence(db, orderId, currentSlice.ordinal === slices.length);
      completeOrderSlice(db, orderId, currentSlice.id, builder);
    } else {
      const revision = db
        .query<{ id: number; worker: string }, [string]>(
          "SELECT id, worker FROM factory_order_build WHERE order_id = ? ORDER BY revision DESC LIMIT 1",
        )
        .get(orderId);
      if (!revision || revision.id === returned?.buildId || revision.worker !== builder) {
        throw new Error("builder did not record a new Build artifact revision");
      }
    }
    return { builder, runId, worktree, exitCode: run.exitCode };
  } catch (error) {
    recordFailure(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
