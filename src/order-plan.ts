import type { Database } from "bun:sqlite";
import type { Capability } from "./capabilities";
import { assertOperator } from "./factory-operator";
import { recordOrderPlan } from "./factory-order";
import { resolveWorker } from "./factory-worker";
import { harnessArgv, runHarnessCommand } from "./harness-command";
import type { HarnessName } from "./harness-name";
import { route } from "./routing";
import { assignedWorker, assignmentProcessEnv, assignWorker } from "./worker-assignment";

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
    "Your first act must be `dim worker bootstrap $DIM_WORKER_ASSIGNMENT_ID` using the assignment in your environment.",
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
