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
import type { Env } from "./paths";
import { route } from "./routing";
import { readSpawnProfile, spawnArgv } from "./spawn-profile";
import { assignedWorker, assignmentProcessEnv, assignWorker } from "./worker-assignment";
import { repoRoot, worktreePath } from "./wt-command";

export const BUILDER_CAPABILITIES: Capability[] = [
  "read-files",
  "edit-files",
  "read-history",
  "ask-dim",
  "run-check",
];

export type BuilderSpawn = (argv: string[], env: Record<string, string>, cwd: string) => { exitCode: number };

const spawnBuilder: BuilderSpawn = (argv, env, cwd) => {
  const run = Bun.spawnSync(argv, {
    cwd,
    env: { ...process.env, ...env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return { exitCode: run.exitCode ?? 1 };
};

export function builderBrief(
  order: { id: string; title: string; description: string | null },
  plan: string,
  runId: string,
): string {
  return [
    `You are the builder for factory order ${order.id} in this repository.`,
    "",
    `# ${order.title}`,
    order.description ?? "",
    "",
    "The operator approved the following plan. Implement only this outcome:",
    "",
    plan,
    "",
    `Your first act is to claim this order under your worker identity: dim order claim ${order.id} --run ${runId} --station dim-station-build.`,
    "Work in the current order worktree. Run the repository's declared check, record every commit, changed file, check, document, and build finding with dim order, and run the build station loop including simplification.",
    "Return a concise outcome. Do not approve the plan or build, start review, ship, or edit outside the order worktree.",
  ].join("\n");
}

export type BuildOutcome = { builder: string; runId: string; worktree: string; exitCode: number };

export function runOrderBuild(
  db: Database,
  orderId: string,
  operator: string,
  options: { dir: string; env?: Env; spawn?: BuilderSpawn },
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
    const { model } = route("builder", options.env);
    const profile = readSpawnProfile(options.env);
    const spawn = options.spawn ?? spawnBuilder;
    const run = spawn(
      spawnArgv(profile, {
        model,
        brief: builderBrief(order, plan.body, runId),
        capabilities: BUILDER_CAPABILITIES,
      }),
      assignmentProcessEnv(options.env, assignment),
      worktree,
    );
    builder = assignedWorker(db, assignment.id);
    if (!builder) throw new Error("builder did not bootstrap its worker assignment");
    if (run.exitCode !== 0) {
      const reason = `${builder} exited with code ${run.exitCode}`;
      recordFailure(reason);
      throw new Error(`${builder} did not finish building`);
    }
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
