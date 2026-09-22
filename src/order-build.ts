import type { Database } from "bun:sqlite";
import type { Capability } from "./capabilities";
import { assertOperator } from "./factory-operator";
import {
  appendOrderEvent,
  isTerminalOrderStatus,
  OrderNotDone,
  orderStatus,
  PlanApprovalRefused,
} from "./factory-order";
import { endWorker } from "./factory-worker";
import type { HarnessAdapter } from "./harness";
import {
  harnessArgv,
  runHarnessCommand,
  runHarnessCommandLive,
  workerFailureReason,
} from "./harness-command";
import type { HarnessName } from "./harness-name";
import type { Env } from "./paths";
import { route } from "./routing";
import { assignedWorker, assignmentProcessEnv, assignWorker, bootstrapWorker } from "./worker-assignment";
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
  plan: string,
  runId: string,
  workspace: ReturnType<typeof workspaceContract>,
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
    plan,
    "",
    `Your first act is to claim this order under your worker identity: dim order claim ${order.id} --run ${runId} --station dim-station-build.`,
    "Work in the current order worktree. Run the command supplied by the workspace profile, record every commit, changed file, check, document, and build finding with dim order, and run the build station loop including simplification.",
    "Return a concise outcome. Do not approve the plan or build, start review, ship, or edit outside the order worktree.",
  ].join("\n");
}

export type BuildOutcome = { builder: string; runId: string; worktree: string; exitCode: number };

function requireBuildEvidence(db: Database, orderId: string): void {
  const commit = db.query("SELECT 1 FROM factory_order_commit WHERE order_id = ? LIMIT 1").get(orderId);
  if (!commit) throw new Error("builder did not record a commit");
  const check = db
    .query<{ exit_code: number }, [string]>(
      "SELECT exit_code FROM factory_order_check WHERE order_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1",
    )
    .get(orderId);
  if (check?.exit_code !== 0) throw new Error("builder did not record a passing check");
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
    .query<{ body: string }, [string]>(
      `SELECT p.body FROM factory_order_plan p
       WHERE p.order_id = ? AND EXISTS (
         SELECT 1 FROM factory_order_event e
         WHERE e.order_id = p.order_id AND e.kind = 'plan_approved' AND e.plan_id = p.id
       )
       ORDER BY p.revision DESC, p.id DESC LIMIT 1`,
    )
    .get(orderId);
  if (!plan) throw new PlanApprovalRefused("plan_missing", `order ${orderId} has no approved plan to build`);
  const assignment = assignWorker(db, { role: "builder", parentWorker: operator });
  const runId = `build-${crypto.randomUUID()}`;
  const worktree = worktreePath(repoRoot(options.dir), orderId);
  const workspace = workspaceContract(worktree);
  let builder: string | undefined;
  let harnessOutput = "";
  let harnessFailureReason: string | undefined;
  let failureRecorded = false;
  const recordFailure = (reason: string): void => {
    if (failureRecorded || isTerminalOrderStatus(orderStatus(db, orderId))) return;
    failureRecorded = true;
    appendOrderEvent(db, orderId, { kind: "failed", worker: builder ?? operator, reason });
  };
  try {
    const env = assignmentProcessEnv(options.env, assignment);
    const harness = options.harness ?? "codex";
    const { model } = route("builder", harness, options.env);
    const run = await runHarnessCommandLive(
      {
        harness,
        cwd: worktree,
        brief: builderBrief(order, plan.body, runId, workspace),
        model,
        capabilities: BUILDER_CAPABILITIES,
        env,
      },
      (providerSessionId) => {
        bootstrapWorker(db, { id: assignment.id, token: assignment.token, sessionId: providerSessionId });
      },
      options.adapter,
    );
    harnessOutput = run.output;
    harnessFailureReason = run.failureReason;
    builder = assignedWorker(db, assignment.id);
    if (!builder) throw new Error("builder did not bootstrap its worker assignment");
    if (run.exitCode !== 0) {
      throw new Error(`${builder} exited with code ${run.exitCode}`);
    }
    requireBuildEvidence(db, orderId);
    return { builder, runId, worktree, exitCode: run.exitCode };
  } catch (error) {
    const reason = workerFailureReason(
      error instanceof Error ? error.message : String(error),
      harnessOutput,
      harnessFailureReason,
    );
    recordFailure(reason);
    throw new Error(reason, { cause: error });
  } finally {
    if (builder) endWorker(db, builder);
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
    .query<{ body: string }, [string]>(
      `SELECT p.body FROM factory_order_plan p
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
  const assignment = assignWorker(db, { role: "builder", parentWorker: operator });
  const runId = `build-${crypto.randomUUID()}`;
  const worktree = worktreePath(repoRoot(options.dir), orderId);
  const workspace = workspaceContract(worktree);
  let builder: string | undefined;
  let failureRecorded = false;
  const recordFailure = (reason: string): void => {
    if (failureRecorded || isTerminalOrderStatus(orderStatus(db, orderId))) return;
    failureRecorded = true;
    appendOrderEvent(db, orderId, {
      kind: "failed",
      worker: builder ?? operator,
      reason,
    });
  };
  try {
    const env = assignmentProcessEnv(options.env, assignment);
    const harness = options.harness ?? "codex";
    const { model } = route("builder", harness, options.env);
    const request = {
      harness,
      cwd: worktree,
      brief: builderBrief(order, plan.body, runId, workspace),
      model,
      capabilities: BUILDER_CAPABILITIES,
      env,
    };
    const run = options.spawn
      ? options.spawn(harnessArgv(request), env, worktree)
      : runHarnessCommand(request);
    builder = assignedWorker(db, assignment.id);
    if (!builder) throw new Error("builder did not bootstrap its worker assignment");
    if (run.exitCode !== 0) {
      const reason = `${builder} exited with code ${run.exitCode}`;
      recordFailure(reason);
      throw new Error(`${builder} did not finish building`);
    }
    requireBuildEvidence(db, orderId);
    return { builder, runId, worktree, exitCode: run.exitCode };
  } catch (error) {
    recordFailure(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (builder) {
      endWorker(db, builder);
    }
  }
}
