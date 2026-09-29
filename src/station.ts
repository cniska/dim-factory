import type { Database } from "bun:sqlite";
import { CodedError } from "./coded-error";
import type { HarnessAdapter } from "./harness";
import type { HarnessName } from "./harness-name";
import { admitAct } from "./order";
import { type ReturnedOrderArtifact, returnedOrderArtifact } from "./order-artifacts";
import { fail } from "./order-contract";
import { appendOrderEvent } from "./order-ledger";
import { startOrder } from "./order-lifecycle";
import { orderStatus } from "./order-status";
import type { Env } from "./paths";
import { holdOrder, startStationAttempt } from "./station-attempt";
import type { BriefedOrder } from "./station-brief";
import { STATION_ROLES, type Station } from "./station-contract";
import { type ExecutionAttribution, ensureOrderWorker, runWorkerTurn } from "./station-worker";
import type { Capability } from "./worker-capabilities";
import { route } from "./worker-routing";

export type StationOptions = {
  dir: string;
  env?: Env;
  harness: HarnessName;
  adapter?: HarnessAdapter;
  checkSandbox?: string[];
};

export type StationLaunch = StationOptions & {
  returned: ReturnedOrderArtifact | null;
  assignmentId: string;
};

export type Prepared<Context> = { cwd: string; brief: string; abort?: () => void; context: Context };

export type StationTurn = {
  orderId: string;
  worker: string;
  runId: string;
  resume(brief: string): Promise<string>;
};

export type StationRun<Context, Outcome> = {
  station: Station;
  capabilities: Capability[];
  outputSchema: string;
  prepare(db: Database, order: BriefedOrder, launch: StationLaunch): Prepared<Context>;
  accept(db: Database, output: string, turn: StationTurn, context: Context): Outcome | Promise<Outcome>;
};

export async function runStation<Context, Outcome>(
  db: Database,
  orderId: string,
  station: StationRun<Context, Outcome>,
  operator: string,
  options: StationOptions,
): Promise<Outcome> {
  const order = db
    .query<BriefedOrder, [string]>("SELECT id, title, description, line FROM factory_order WHERE id = ?")
    .get(orderId);
  if (!order) throw fail("order_unknown", { orderId });
  using hold = holdOrder(orderId, options.env);
  admitAct(db, orderId, station.station, operator);
  const role = STATION_ROLES[station.station];
  const { model } = route(role, options.harness, options.env);
  if (orderStatus(db, orderId) === "queued") startOrder(db, orderId, operator, undefined, options.dir);
  const runId = `${station.station}-${crypto.randomUUID()}`;
  const orderWorker = ensureOrderWorker(db, orderId, role, operator, options.harness);
  let claimed: string | undefined;
  let abort: (() => void) | undefined;
  try {
    const prepared = station.prepare(db, order, {
      ...options,
      returned: returnedOrderArtifact(db, orderId, station.station),
      assignmentId: orderWorker.assignment.id,
    });
    abort = prepared.abort;
    const request = (brief: string) => ({
      cwd: prepared.cwd,
      brief,
      capabilities: station.capabilities,
      outputSchema: station.outputSchema,
      harness: options.harness,
      model,
      env: {},
    });
    const claim = (assigned: string, sessionId: string, attribution: ExecutionAttribution): void => {
      startStationAttempt(
        db,
        orderId,
        {
          runId,
          worker: assigned,
          operatorWorker: operator,
          station: station.station,
          sessionId,
          providerSessionId: sessionId,
          ...attribution,
        },
        new Date().toISOString(),
      );
      claimed = assigned;
      hold.release();
    };
    const first = await runWorkerTurn(
      db,
      station.station,
      request(prepared.brief),
      orderWorker,
      options.env,
      options.adapter,
      claim,
    );
    let latest = first.worker;
    const resume = async (brief: string): Promise<string> => {
      const next = await runWorkerTurn(
        db,
        station.station,
        request(brief),
        latest,
        options.env,
        options.adapter,
      );
      latest = next.worker;
      return next.output;
    };
    return await station.accept(
      db,
      first.output,
      { orderId, worker: first.worker.bound.name, runId, resume },
      prepared.context,
    );
  } catch (error) {
    abort?.();
    const limited = error instanceof CodedError && error.code === "usage_limited";
    if (!limited && orderStatus(db, orderId) === "running") {
      appendOrderEvent(db, orderId, {
        kind: "failed",
        station: station.station,
        worker: claimed,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}
