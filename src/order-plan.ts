import type { Database } from "bun:sqlite";
import type { Capability } from "./capabilities";
import { assertOperator } from "./factory-operator";
import { appendOrderEvent, recordOrderPlan } from "./factory-order";
import { endWorker, resolveWorker } from "./factory-worker";
import {
  harnessArgv,
  runHarnessCommand,
  runHarnessCommandLive,
  workerFailureReason,
} from "./harness-command";
import type { HarnessName } from "./harness-name";
import { route } from "./routing";
import { assignedWorker, assignmentProcessEnv, assignWorker, bootstrapWorker } from "./worker-assignment";

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
    "Write one plain Markdown plan for the owner to read on the factory wall.",
    "Include the outcome, evidence, contracts, independently verifiable slices, risks, holds, and non-goals.",
    "The factory runner has already created your worker identity from this harness session before your first tool call.",
    "Return only the Markdown plan. Do not edit files, commit, or run mutation commands.",
  ].join("\n");
}

export type PlanOutcome = { planner: string; body: string };

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
  const assignment = assignWorker(db, { role: "planner", parentWorker });
  const harness = options.harness ?? "codex";
  const { model } = route("planner", harness, options.env);
  const env = assignmentProcessEnv(options.env ?? process.env, assignment);
  const request = {
    harness,
    cwd: process.cwd(),
    brief: plannerBrief(order),
    model,
    capabilities: PLANNER_CAPABILITIES,
    env,
  };
  const run = options.spawn ? options.spawn(harnessArgv(request), env) : runHarnessCommand(request);
  if (run.exitCode !== 0) throw new Error("planner did not finish planning");
  const body = ("stdout" in run ? run.stdout : run.output).trim();
  const planner = assignedWorker(db, assignment.id);
  if (!planner) throw new Error("planner did not bootstrap its worker assignment");
  recordOrderPlan(db, orderId, body, planner);
  return { planner, body };
}

export async function runOrderPlanLive(
  db: Database,
  orderId: string,
  options: { env?: Record<string, string | undefined>; harness?: HarnessName } = {},
): Promise<PlanOutcome> {
  const order = db
    .query<{ id: string; title: string; description: string | null }, [string]>(
      "SELECT id, title, description FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  const parentWorker = resolveWorker(db, options.env);
  assertOperator(db, parentWorker, "delegate planning");
  const assignment = assignWorker(db, { role: "planner", parentWorker });
  const harness = options.harness ?? "codex";
  const { model } = route("planner", harness, options.env);
  const env = assignmentProcessEnv(options.env ?? process.env, assignment);
  const request = {
    harness,
    cwd: process.cwd(),
    brief: plannerBrief(order),
    model,
    capabilities: PLANNER_CAPABILITIES,
    env,
  };
  let planner: string | undefined;
  try {
    const run = await runHarnessCommandLive(request, (providerSessionId) => {
      bootstrapWorker(db, { id: assignment.id, token: assignment.token, sessionId: providerSessionId });
    });
    planner = assignedWorker(db, assignment.id);
    if (!planner) throw new Error("planner did not bootstrap its worker assignment");
    if (run.exitCode !== 0) {
      throw new Error(workerFailureReason("planner did not finish planning", run.output, run.failureReason));
    }
    const body = run.output.trim();
    recordOrderPlan(db, orderId, body, planner);
    return { planner, body };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (planner) appendOrderEvent(db, orderId, { kind: "failed", worker: planner, reason });
    throw error;
  } finally {
    if (planner) endWorker(db, planner);
  }
}
