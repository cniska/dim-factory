import type { Database } from "bun:sqlite";
import { assertOperator } from "./factory-operator";
import type { HarnessAdapter } from "./harness";
import { workerFailureReason } from "./harness-launch";
import type { HarnessName } from "./harness-name";
import { recordOrderPlan } from "./order-artifacts";
import { appendOrderEvent } from "./order-ledger";
import { startOrder } from "./order-lifecycle";
import { assertNext } from "./order-state";
import { orderStatus } from "./order-status";
import { stationDirectory } from "./station-directory";
import { type PlanSlice, parsePlanArtifact } from "./station-plan-artifact";
import { runOrderStationLive } from "./station-worker";
import { resolveWorker } from "./worker";
import type { Capability } from "./worker-capabilities";

const PLAN_OUTPUT_SCHEMA = `${import.meta.dir}/station-plan-artifact.schema.json`;

export const PLANNER_CAPABILITIES: Capability[] = [
  "bootstrap-worker",
  "read-files",
  "read-history",
  "ask-dim",
];

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

export async function runOrderPlanLive(
  db: Database,
  orderId: string,
  options: {
    dir: string;
    env?: Record<string, string | undefined>;
    harness: HarnessName;
    adapter?: HarnessAdapter;
  },
): Promise<PlanOutcome> {
  const order = db
    .query<{ id: string; title: string; description: string | null }, [string]>(
      "SELECT id, title, description FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  const parentWorker = resolveWorker(db, options.env);
  assertOperator(db, parentWorker, "delegate planning");
  assertNext(db, orderId, "plan");
  if (orderStatus(db, orderId) === "queued") startOrder(db, orderId, parentWorker, undefined, options.dir);
  const harness = options.harness;
  let planner: string | undefined;
  try {
    const { run, worker } = await runOrderStationLive({
      db,
      orderId,
      station: "plan",
      parentWorker,
      harness,
      env: options.env,
      adapter: options.adapter,
      onPrepared: (orderWorker) => {
        planner = orderWorker.worker;
      },
      request: ({ returned }) => ({
        cwd: stationDirectory(options.dir, orderId),
        brief: plannerBrief(order, returned ? { body: returned.body, feedback: returned.reason } : undefined),
        capabilities: PLANNER_CAPABILITIES,
        outputSchema: PLAN_OUTPUT_SCHEMA,
      }),
    });
    planner = worker;
    if (run.exitCode !== 0) {
      throw new Error(workerFailureReason("planner did not finish planning", run.output, run.failureReason));
    }
    if (!planner) throw new Error("planner did not bootstrap its worker assignment");
    const artifact = parsePlanArtifact(run.output.trim());
    recordOrderPlan(db, orderId, artifact.body, planner, artifact.slices);
    return { planner, ...artifact };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (planner) appendOrderEvent(db, orderId, { kind: "failed", worker: planner, reason });
    throw error;
  }
}
