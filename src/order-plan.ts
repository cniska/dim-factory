import type { Database } from "bun:sqlite";
import type { Capability } from "./capabilities";
import { assertOperator } from "./factory-operator";
import { appendOrderEvent, recordOrderPlan } from "./factory-order";
import { resolveWorker } from "./factory-worker";
import type { HarnessAdapter } from "./harness";
import {
  harnessArgv,
  runHarnessCommand,
  runHarnessCommandLive,
  workerFailureReason,
} from "./harness-command";
import type { HarnessName } from "./harness-name";
import {
  bindOrderWorker,
  bindOrderWorkerName,
  bindOrderWorkerSession,
  ensureOrderWorker,
  orderWorkerRequest,
} from "./order-worker";
import { type PlanSlice, parsePlanArtifact } from "./plan-artifact";
import { route } from "./routing";
import { assignedWorker, bootstrapWorker } from "./worker-assignment";

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

export function plannerBrief(order: { id: string; title: string; description: string | null }): string {
  return [
    `You are the planner for factory order ${order.id} in this repository.`,
    "",
    `# ${order.title}`,
    order.description ?? "",
    "",
    "Read the repository rules and prior decisions before proposing work.",
    "Write one Markdown plan for the owner to read on the factory wall and the builder to execute, and list its independently verifiable slices.",
    "Write for both readers: state the outcome, boundary, non-goals, and owner decisions.",
    "Scale the explanation to the change: lead with a concise decision summary, then include only the supporting detail needed for its risk and size; never omit a required contract dimension.",
    "Show the evidence and what it ruled out; state contracts, invariants, states, transitions, errors, and ownership.",
    "Include program design: file tree, key signatures, call path, data flow, and boundary crossings.",
    "Name an executable check for each contract and give every slice a behavior, affected area, check, and dependency.",
    "End with risks, holds, unresolved questions, predictions, and the conditions for approval.",
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
  const orderWorker = ensureOrderWorker(db, orderId, "planner", parentWorker);
  const harness = options.harness ?? "codex";
  const { model } = route("planner", harness, options.env);
  const env = orderWorkerRequest(db, options.env ?? process.env, orderWorker);
  const request = {
    harness,
    cwd: process.cwd(),
    brief: plannerBrief(order),
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
  const orderWorker = ensureOrderWorker(db, orderId, "planner", parentWorker);
  const harness = options.harness ?? "codex";
  const { model } = route("planner", harness, options.env);
  const env = orderWorkerRequest(db, options.env ?? process.env, orderWorker);
  const request = {
    harness,
    cwd: process.cwd(),
    brief: plannerBrief(order),
    model,
    capabilities: PLANNER_CAPABILITIES,
    outputSchema: PLAN_OUTPUT_SCHEMA,
    env,
  };
  let planner = orderWorker.worker;
  try {
    const onStarted = (providerSessionId: string): void => {
      if (orderWorker.worker) {
        bindOrderWorkerSession(db, orderId, "planner", providerSessionId);
      } else {
        const minted = bootstrapWorker(db, {
          id: orderWorker.assignment.id,
          token: orderWorker.assignment.token,
          sessionId: providerSessionId,
        });
        bindOrderWorker(db, orderId, "planner", orderWorker.assignment.id, minted);
        planner = minted.name;
      }
    };
    const run = await runHarnessCommandLive(request, onStarted, options.adapter);
    if (!planner) throw new Error("planner did not bootstrap its worker assignment");
    if (run.exitCode !== 0) {
      throw new Error(workerFailureReason("planner did not finish planning", run.output, run.failureReason));
    }
    const artifact = parsePlanArtifact(run.output.trim());
    recordOrderPlan(db, orderId, artifact.body, planner, artifact.slices);
    return { planner, ...artifact };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (planner) appendOrderEvent(db, orderId, { kind: "failed", worker: planner, reason });
    throw error;
  }
}
