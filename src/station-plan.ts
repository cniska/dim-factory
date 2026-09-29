import type { Database } from "bun:sqlite";
import type { HarnessAdapter } from "./harness";
import { workerFailureReason } from "./harness-launch";
import type { HarnessName } from "./harness-name";
import { admitAct } from "./order";
import { recordOrderPlan } from "./order-artifacts";
import { finishAttempt } from "./order-attempt";
import { appendOrderEvent } from "./order-ledger";
import { startOrder } from "./order-lifecycle";
import { orderStatus } from "./order-status";
import { startStationAttempt } from "./station-attempt";
import { type BriefedOrder, briefHeader } from "./station-brief";
import { stationDirectory } from "./station-directory";
import { type PlanSlice, parsePlanArtifact } from "./station-plan-artifact";
import { orderWorkerIsBound, runOrderStationLive } from "./station-worker";
import type { Capability } from "./worker-capabilities";

const PLAN_OUTPUT_SCHEMA = `${import.meta.dir}/station-plan-artifact.schema.json`;

export const PLANNER_CAPABILITIES: Capability[] = [
  "bootstrap-worker",
  "read-files",
  "read-history",
  "ask-dim",
];

export function plannerBrief(order: BriefedOrder, revision?: { body: string; feedback: string }): string {
  return [
    ...briefHeader("planner", "dim-plan", order),
    ...(revision
      ? ["", "## Returned Plan artifact", revision.body, "", "## Owner feedback", revision.feedback]
      : []),
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
    parentWorker: string;
    adapter?: HarnessAdapter;
  },
): Promise<PlanOutcome> {
  const order = db
    .query<BriefedOrder, [string]>("SELECT id, title, description, line FROM factory_order WHERE id = ?")
    .get(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  const parentWorker = options.parentWorker;
  admitAct(db, orderId, "plan", parentWorker);
  if (orderStatus(db, orderId) === "queued") startOrder(db, orderId, parentWorker, undefined, options.dir);
  const harness = options.harness;
  const runId = `plan-${crypto.randomUUID()}`;
  let planner: string | undefined;
  let claimed = false;
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
      onAssigned: (assigned, providerSessionId, attribution) => {
        planner = assigned;
        startStationAttempt(
          db,
          orderId,
          {
            runId,
            worker: assigned,
            operatorWorker: parentWorker,
            station: "plan",
            sessionId: providerSessionId,
            providerSessionId,
            ...attribution,
          },
          new Date().toISOString(),
        );
        claimed = true;
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
    finishAttempt(db, orderId, "succeeded", undefined, new Date().toISOString());
    return { planner, ...artifact };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    appendOrderEvent(db, orderId, {
      kind: "failed",
      station: "plan",
      worker: claimed ? planner : undefined,
      reason,
      evidence: { turn: orderWorkerIsBound(db, orderId, "planner", planner) },
    });
    throw error;
  }
}
