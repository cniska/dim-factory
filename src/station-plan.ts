import { recordOrderPlan } from "./order-artifacts";
import type { StationRun } from "./station";
import { type BriefedOrder, briefHeader } from "./station-brief";
import { stationDirectory } from "./station-directory";
import { type PlanSlice, parsePlanArtifact } from "./station-plan-artifact";

export function plannerBrief(order: BriefedOrder, revision?: { body: string; feedback: string }): string {
  return [
    ...briefHeader("planner", "dim-plan", order),
    ...(revision
      ? ["", "## Returned Plan artifact", revision.body, "", "## Owner feedback", revision.feedback]
      : []),
  ].join("\n");
}

type PlanOutcome = { planner: string; body: string; slices: readonly PlanSlice[] };

export const planStation: StationRun<null, PlanOutcome> = {
  station: "plan",
  edits: false,
  outputSchema: `${import.meta.dir}/station-plan-artifact.schema.json`,
  prepare: (_db, order, { dir, returned }) => ({
    cwd: stationDirectory(dir, order.id),
    brief: plannerBrief(order, returned ? { body: returned.body, feedback: returned.reason } : undefined),
    context: null,
  }),
  accept: (db, output, turn) => {
    const artifact = parsePlanArtifact(output.trim());
    recordOrderPlan(db, turn.orderId, artifact.body, turn.worker, artifact.slices);
    return { planner: turn.worker, ...artifact };
  },
};
