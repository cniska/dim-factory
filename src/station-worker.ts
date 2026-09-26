import type { Database } from "bun:sqlite";
import { assertOperator } from "./factory-operator";
import type { HarnessAdapter } from "./harness";
import {
  type HarnessLaunch,
  type HarnessLaunchResult,
  type HarnessStarted,
  launchHarnessLive,
  resumeHarnessLive,
} from "./harness-launch";
import type { HarnessName } from "./harness-name";
import { type ReturnedOrderArtifact, returnedOrderArtifact } from "./order-artifacts";
import { authenticateWorker, endWorker, type MintedWorker, startWorkerRun, workerProcessEnv } from "./worker";
import {
  assignedWorker,
  assignmentProcessEnv,
  bootstrapWorker,
  createWorkerAssignment,
  renewWorkerAssignment,
  type WorkerAssignment,
} from "./worker-assignment";
import { readWorkerCredential, saveWorkerCredential } from "./worker-credential";
import type { Role } from "./worker-roles";
import { route } from "./worker-routing";

export type StationRole = Exclude<Role, "operator">;

export type OrderWorker = {
  orderId: string;
  role: StationRole;
  assignment: WorkerAssignment;
  worker?: string;
  providerSessionId?: string;
  harness: HarnessName;
};

export type OrderStationName = "plan" | "build" | "review";
export type ExecutionAttribution = { harness: HarnessLaunch["harness"]; model: string; tier: string };

const STATION_ROLES = {
  plan: "planner",
  build: "builder",
  review: "reviewer",
} as const satisfies Record<OrderStationName, StationRole>;
type ReturnedFor<Station extends OrderStationName> = Extract<ReturnedOrderArtifact, { station: Station }>;
type StationRequest = Omit<HarnessLaunch, "harness" | "model" | "env">;

type OrderStationOptions<Station extends OrderStationName> = {
  db: Database;
  orderId: string;
  station: Station;
  parentWorker: string;
  harness: HarnessLaunch["harness"];
  env?: Record<string, string | undefined>;
  useReturnedArtifact?: boolean;
  requireReturnedArtifact?: boolean;
  request(context: { returned: ReturnedFor<Station> | null; orderWorker: OrderWorker }): StationRequest;
  onPrepared?(orderWorker: OrderWorker, returned: ReturnedFor<Station> | null): void;
};

export type OrderStationTurn<Station extends OrderStationName> = {
  orderWorker: OrderWorker;
  returned: ReturnedFor<Station> | null;
  worker?: string;
  run: Pick<HarnessLaunchResult, "exitCode" | "output" | "failureReason" | "harnessExitCode">;
};

function prepareOrderStation<Station extends OrderStationName>(options: OrderStationOptions<Station>) {
  const role = STATION_ROLES[options.station];
  assertOperator(options.db, options.parentWorker, `delegate ${role}`);
  const returned = (
    options.useReturnedArtifact === false
      ? null
      : returnedOrderArtifact(options.db, options.orderId, options.station)
  ) as ReturnedFor<Station> | null;
  if (options.requireReturnedArtifact && !returned) {
    throw new Error(`order ${options.orderId} has no returned ${options.station} artifact to revise`);
  }
  const orderWorker = ensureOrderWorker(
    options.db,
    options.orderId,
    role,
    options.parentWorker,
    options.harness,
  );
  options.onPrepared?.(orderWorker, returned);
  const { model } = route(role, options.harness, options.env);
  const request = {
    ...options.request({ returned, orderWorker }),
    harness: options.harness,
    model,
    env: {},
  };
  return { orderWorker, returned, request };
}

export async function runOrderStationLive<Station extends OrderStationName>(
  options: OrderStationOptions<Station> & {
    adapter?: HarnessAdapter;
    onAssigned?: (worker: string, sessionId: string, attribution: ExecutionAttribution) => void;
  },
): Promise<OrderStationTurn<Station>> {
  const { orderWorker, returned, request } = prepareOrderStation(options);
  const run = await runOrderWorkerHarnessLive(
    options.db,
    request,
    orderWorker,
    options.env,
    options.adapter,
    options.onAssigned,
  );
  return { orderWorker, returned, worker: run.worker, run };
}

export async function resumeOrderStationLive(options: {
  db: Database;
  orderId: string;
  station: OrderStationName;
  harness: HarnessName;
  env?: Record<string, string | undefined>;
  adapter?: HarnessAdapter;
  request: StationRequest;
}): Promise<OrderStationTurn<OrderStationName>["run"]> {
  const role = STATION_ROLES[options.station];
  const orderWorker = readOrderWorker(options.db, options.orderId, role);
  refuseHarnessSwitch(orderWorker, options.harness);
  if (!orderWorker?.worker || !orderWorker.providerSessionId) {
    throw new Error(`order ${options.orderId} ${role} has no bound session to resume`);
  }
  const { model } = route(role, options.harness, options.env);
  return runOrderWorkerHarnessLive(
    options.db,
    { ...options.request, harness: options.harness, model, env: {} },
    orderWorker,
    options.env,
    options.adapter,
  );
}

export function runOrderWorkerHarnessLive(
  db: Database,
  request: HarnessLaunch,
  worker: OrderWorker,
  machine: Record<string, string | undefined> | undefined,
  adapter?: HarnessAdapter,
  onAssigned?: (worker: string, sessionId: string, attribution: ExecutionAttribution) => void,
): Promise<Awaited<ReturnType<typeof launchHarnessLive>> & { worker?: string }> {
  const env = orderWorkerRequest(db, machine, worker);
  let name = worker.worker;
  let running: string | undefined;
  const onStarted: HarnessStarted = (sessionId, pid) => {
    if (name) {
      startWorkerRun(db, name, pid);
      running = name;
      bindOrderWorkerSession(db, worker.orderId, worker.role, sessionId);
    } else {
      const minted = bootstrapWorker(db, {
        id: worker.assignment.id,
        token: worker.assignment.token,
        sessionId,
        pid,
      });
      running = minted.name;
      saveWorkerCredential(machine ?? process.env, minted);
      bindOrderWorker(db, worker.orderId, worker.role, worker.assignment.id, minted);
      name = minted.name;
    }
    const { tier, model } = route(worker.role, request.harness, machine);
    onAssigned?.(name, sessionId, { harness: request.harness, model, tier });
  };
  const run = worker.providerSessionId
    ? resumeHarnessLive({ ...request, env }, worker.providerSessionId, onStarted, adapter)
    : launchHarnessLive({ ...request, env }, onStarted, adapter);
  return run
    .then((result) => ({
      ...result,
      worker: name ?? assignedWorker(db, worker.assignment.id) ?? undefined,
    }))
    .finally(() => {
      if (running) endWorker(db, running);
    });
}

function readOrderWorker(db: Database, orderId: string, role: StationRole): OrderWorker | undefined {
  const row = db
    .query<
      {
        assignment_id: string;
        parent_worker: string;
        assignment_role: StationRole;
        created_at: string;
        worker: string | null;
        provider_session_id: string | null;
        harness: HarnessName;
      },
      [string, string]
    >(
      `SELECT ow.assignment_id, a.parent_worker, a.role AS assignment_role, a.created_at, ow.harness,
              coalesce(ow.worker, a.accepted_worker) AS worker,
              coalesce(ow.provider_session_id, w.session_id) AS provider_session_id
       FROM factory_order_worker ow
       JOIN factory_worker_assignment a ON a.id = ow.assignment_id
       LEFT JOIN factory_worker w ON w.name = a.accepted_worker
       WHERE ow.order_id = ? AND ow.role = ?`,
    )
    .get(orderId, role);
  if (!row) return undefined;
  return {
    orderId,
    role,
    assignment: {
      id: row.assignment_id,
      token: "",
      parentWorker: row.parent_worker,
      role: row.assignment_role,
      createdAt: row.created_at,
    },
    worker: row.worker ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    harness: row.harness,
  };
}

function refuseHarnessSwitch(existing: OrderWorker | undefined, harness: HarnessName): void {
  if (existing?.worker && existing.harness !== harness) {
    throw new Error(
      `order ${existing.orderId} ${existing.role} runs under the ${existing.harness} harness; delegate it with --harness ${existing.harness}`,
    );
  }
}

export function assertOrderWorkerHarness(
  db: Database,
  orderId: string,
  role: StationRole,
  harness: HarnessName,
): void {
  refuseHarnessSwitch(readOrderWorker(db, orderId, role), harness);
}

export function ensureOrderWorker(
  db: Database,
  orderId: string,
  role: StationRole,
  parentWorker: string,
  harness: HarnessName,
  at = new Date().toISOString(),
): OrderWorker {
  const existing = readOrderWorker(db, orderId, role);
  refuseHarnessSwitch(existing, harness);
  if (existing) {
    if (existing.worker) return existing;
    return db.transaction(() => {
      db.run("UPDATE factory_order_worker SET harness = ? WHERE order_id = ? AND role = ?", [
        harness,
        orderId,
        role,
      ]);
      return { ...existing, harness, assignment: renewWorkerAssignment(db, existing.assignment.id) };
    })();
  }

  return db.transaction(() => {
    const assignment = createWorkerAssignment(db, { parentWorker, role }, at);
    db.run(
      `INSERT INTO factory_order_worker
       (order_id, role, assignment_id, harness, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [orderId, role, assignment.id, harness, at],
    );
    return { orderId, role, assignment, harness };
  })();
}

export function bindOrderWorker(
  db: Database,
  orderId: string,
  role: StationRole,
  assignmentId: string,
  worker: MintedWorker,
): void {
  const result = db.run(
    `UPDATE factory_order_worker
     SET worker = ?, provider_session_id = ?
     WHERE order_id = ? AND role = ? AND assignment_id = ? AND worker IS NULL`,
    [worker.name, worker.sessionId, orderId, role, assignmentId],
  );
  if (result.changes !== 1) {
    const existing = readOrderWorker(db, orderId, role);
    if (existing?.worker === worker.name && existing.providerSessionId === worker.sessionId) return;
    throw new Error(`order ${orderId} ${role} worker binding was not writable`);
  }
}

export function bindOrderWorkerName(
  db: Database,
  orderId: string,
  role: StationRole,
  assignmentId: string,
  worker: string,
): void {
  const session = db
    .query<{ session_id: string }, [string]>("SELECT session_id FROM factory_worker WHERE name = ?")
    .get(worker);
  if (!session) throw new Error(`worker ${worker} was not registered`);
  const result = db.run(
    `UPDATE factory_order_worker
     SET worker = ?, provider_session_id = ?
     WHERE order_id = ? AND role = ? AND assignment_id = ? AND worker IS NULL`,
    [worker, session.session_id, orderId, role, assignmentId],
  );
  if (result.changes !== 1) {
    const existing = readOrderWorker(db, orderId, role);
    if (existing?.worker === worker && existing.providerSessionId === session.session_id) return;
    throw new Error(`order ${orderId} ${role} worker binding was not writable`);
  }
}

export function bindOrderWorkerSession(
  db: Database,
  orderId: string,
  role: StationRole,
  providerSessionId: string,
): void {
  const result = db.run(
    `UPDATE factory_order_worker
     SET provider_session_id = ?
     WHERE order_id = ? AND role = ? AND worker IS NOT NULL`,
    [providerSessionId, orderId, role],
  );
  if (result.changes !== 1) throw new Error(`order ${orderId} ${role} worker session was not writable`);
}

export function orderWorkerRequest(
  db: Database,
  machine: Record<string, string | undefined> | undefined,
  orderWorker: OrderWorker,
): Record<string, string> {
  if (!orderWorker.worker) return assignmentProcessEnv(machine, orderWorker.assignment);
  if (!orderWorker.providerSessionId) {
    throw new Error(`order ${orderWorker.orderId} ${orderWorker.role} worker has no provider session`);
  }
  const credential = readWorkerCredential(machine ?? process.env, orderWorker.providerSessionId);
  if (credential?.name !== orderWorker.worker) {
    throw new Error(`order ${orderWorker.orderId} ${orderWorker.role} worker credential is unavailable`);
  }
  const env = workerProcessEnv(machine, credential);
  if (authenticateWorker(db, env).name !== orderWorker.worker) {
    throw new Error(`order ${orderWorker.orderId} ${orderWorker.role} worker credential changed identity`);
  }
  return env;
}
