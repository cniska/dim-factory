import type { Database } from "bun:sqlite";
import type { Capability } from "./capabilities";
import { assertOperator } from "./factory-operator";
import { appendOrderEvent, recordOrderPlan, returnedOrderArtifact } from "./factory-order";
import { resolveWorker } from "./factory-worker";
import type { HarnessAdapter } from "./harness";
import { harnessArgv, runHarnessCommand, workerFailureReason } from "./harness-command";
import type { HarnessName } from "./harness-name";
import {
  bindOrderWorkerName,
  ensureOrderWorker,
  orderWorkerRequest,
  runOrderWorkerHarnessLive,
} from "./order-worker";
import { type PlanSlice, parsePlanArtifact } from "./plan-artifact";
import { route } from "./routing";
import { assignedWorker } from "./worker-assignment";

const PLAN_OUTPUT_SCHEMA = `${import.meta.dir}/plan-artifact.schema.json`;

/** Reads and searches the repository, its history and the record — never edits, never raises a finding. */
export const PLANNER_CAPABILITIES: Capability[] = [
  "bootstrap-worker",
  "read-files",
  "read-history",
  "ask-dim",
];

export type PlannerSpawn = (
  argv: string[],
  env: Record<string, string>,
) => {
  exitCode: number;
  stdout: string;
};

export function plannerBrief(
  order: { id: string; title: string; description: string | null },
  revision?: { body: string; feedback: string },
): string {
  return [
    `You are the planner for factory order ${order.id} in this repository.`,
    "",
    `# ${order.title}`,
    order.description ?? "",
    ...(revision
      ? [
          "",
          "The owner returned this Plan artifact. Address the feedback and write a new revision.",
          "",
          "# Previous Plan",
          revision.body,
          "",
          "# Owner feedback",
          revision.feedback,
        ]
      : []),
    "",
    "Read the repository rules and prior decisions before proposing work.",
    "Write one Markdown plan for the owner to read on the factory wall and the builder to execute, and list its independently verifiable slices.",
    "Write for both readers: state the outcome, boundary, non-goals, and owner decisions.",
    "Use dim-artifact for the shared artifact-writing and sizing contract.",
    "For this Plan artifact, include only the outcome, boundary, evidence, contracts, slices, checks, risks, and owner decisions that this change needs.",
    "The factory runner has already created your worker identity from this harness session before your first tool call.",
    'Return exactly one JSON object with a non-empty string "body" and a non-empty "slices" array. Each slice has a non-empty "title" and "outcome". Do not use a Markdown fence or add any text outside the JSON object. Do not edit files, commit, or run mutation commands.',
  ].join("\n");
}

export type PlanOutcome = { planner: string; body: string; slices: readonly PlanSlice[] };

export function runOrderPlan(
  db: Database,
  orderId: string,
  options: {
    env?: Record<string, string | undefined>;
    spawn?: PlannerSpawn;
    harness?: HarnessName;
  } = {},
): PlanOutcome {
  const order = db
    .query<{ id: string; title: string; description: string | null }, [string]>(
      "SELECT id, title, description FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  const parentWorker = resolveWorker(db, options.env);
  assertOperator(db, parentWorker, "delegate planning");
  const returned = returnedOrderArtifact(db, orderId, "plan");
  const previous = returned?.planId
    ? db
        .query<{ body: string }, [number]>("SELECT body FROM factory_order_plan WHERE id = ?")
        .get(returned.planId)
    : undefined;
  const orderWorker = ensureOrderWorker(db, orderId, "planner", parentWorker);
  const harness = options.harness ?? "codex";
  const { model } = route("planner", harness, options.env);
  const env = orderWorkerRequest(db, options.env ?? process.env, orderWorker);
  const request = {
    harness,
    cwd: process.cwd(),
    brief: plannerBrief(
      order,
      previous
        ? { body: previous.body, feedback: returned?.reason ?? "Revise the Plan artifact." }
        : undefined,
    ),
    model,
    capabilities: PLANNER_CAPABILITIES,
    outputSchema: PLAN_OUTPUT_SCHEMA,
    env,
  };
  const run = options.spawn ? options.spawn(harnessArgv(request), env) : runHarnessCommand(request);
  if (run.exitCode !== 0) throw new Error("planner did not finish planning");
  const artifact = parsePlanArtifact(("stdout" in run ? run.stdout : run.output).trim());
  const planner = assignedWorker(db, orderWorker.assignment.id);
  if (!planner) throw new Error("planner did not bootstrap its worker assignment");
  bindOrderWorkerName(db, orderId, "planner", orderWorker.assignment.id, planner);
  recordOrderPlan(db, orderId, artifact.body, planner, artifact.slices);
  return { planner, ...artifact };
}

export async function runOrderPlanLive(
  db: Database,
  orderId: string,
  options: {
    env?: Record<string, string | undefined>;
    harness?: HarnessName;
    adapter?: HarnessAdapter;
  } = {},
): Promise<PlanOutcome> {
  const order = db
    .query<{ id: string; title: string; description: string | null }, [string]>(
      "SELECT id, title, description FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  const parentWorker = resolveWorker(db, options.env);
  assertOperator(db, parentWorker, "delegate planning");
  const returned = returnedOrderArtifact(db, orderId, "plan");
  const previous = returned?.planId
    ? db
        .query<{ body: string }, [number]>("SELECT body FROM factory_order_plan WHERE id = ?")
        .get(returned.planId)
    : undefined;
  const orderWorker = ensureOrderWorker(db, orderId, "planner", parentWorker);
  const harness = options.harness ?? "codex";
  const { model } = route("planner", harness, options.env);
  const request = {
    harness,
    cwd: process.cwd(),
    brief: plannerBrief(
      order,
      previous
        ? { body: previous.body, feedback: returned?.reason ?? "Revise the Plan artifact." }
        : undefined,
    ),
    model,
    capabilities: PLANNER_CAPABILITIES,
    outputSchema: PLAN_OUTPUT_SCHEMA,
    env: {},
  };
  let planner = orderWorker.worker;
  try {
    const run = await runOrderWorkerHarnessLive(db, request, orderWorker, options.env, options.adapter);
    planner = run.worker;
    if (run.exitCode !== 0) {
      throw new Error(workerFailureReason("planner did not finish planning", run.output, run.failureReason));
    }
    if (!run.worker) throw new Error("planner did not bootstrap its worker assignment");
    planner = run.worker;
    const artifact = parsePlanArtifact(run.output.trim());
    recordOrderPlan(db, orderId, artifact.body, planner, artifact.slices);
    return { planner, ...artifact };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (planner) appendOrderEvent(db, orderId, { kind: "failed", worker: planner, reason });
    throw error;
  }
}
