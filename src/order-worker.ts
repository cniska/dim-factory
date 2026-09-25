import type { Database } from "bun:sqlite";
import { assertOperator } from "./factory-operator";
import { type ReturnedOrderArtifact, returnedOrderArtifact } from "./factory-order";
import { type MintedWorker, resolveWorker, workerProcessEnv } from "./factory-worker";
import type { HarnessAdapter } from "./harness";
import {
  type HarnessCommandRequest,
  type HarnessCommandResult,
  type HarnessStarted,
  harnessArgv,
  runHarnessCommand,
  runHarnessCommandLive,
  runHarnessCommandResumeLive,
} from "./harness-command";
import type { Role } from "./roles";
import { route } from "./routing";
import {
  assignedWorker,
  assignmentProcessEnv,
  bootstrapWorker,
  createWorkerAssignment,
  renewWorkerAssignment,
  type WorkerAssignment,
} from "./worker-assignment";
import { readWorkerCredential, saveWorkerCredential } from "./worker-credential";

export type StationRole = Exclude<Role, "operator">;

export type OrderWorker = {
  orderId: string;
  role: StationRole;
  assignment: WorkerAssignment;
  worker?: string;
  providerSessionId?: string;
};

export type OrderStationName = "plan" | "build" | "review";
export type ExecutionAttribution = { harness: HarnessCommandRequest["harness"]; model: string; tier: string };

const STATION_ROLES = {
  plan: "planner",
  build: "builder",
  review: "reviewer",
} as const satisfies Record<OrderStationName, StationRole>;
type ReturnedFor<Station extends OrderStationName> = Extract<ReturnedOrderArtifact, { station: Station }>;
type StationRequest = Omit<HarnessCommandRequest, "harness" | "model" | "env">;

type OrderStationOptions<Station extends OrderStationName> = {
  db: Database;
  orderId: string;
  station: Station;
  parentWorker: string;
  harness: HarnessCommandRequest["harness"];
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
  run: Pick<HarnessCommandResult, "exitCode" | "output" | "failureReason">;
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
  const orderWorker = ensureOrderWorker(options.db, options.orderId, role, options.parentWorker);
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

export function runOrderStation<Station extends OrderStationName>(
  options: OrderStationOptions<Station> & {
    spawn?: (argv: string[], env: Record<string, string>) => { exitCode: number; output: string };
  },
): OrderStationTurn<Station> {
  const { orderWorker, returned, request } = prepareOrderStation(options);
  const env = orderWorkerRequest(options.db, options.env, orderWorker);
  const run = options.spawn
    ? options.spawn(harnessArgv({ ...request, env }), env)
    : runHarnessCommand({ ...request, env });
  const worker = assignedWorker(options.db, orderWorker.assignment.id) ?? undefined;
  if (worker)
    bindOrderWorkerName(options.db, options.orderId, orderWorker.role, orderWorker.assignment.id, worker);
  return { orderWorker, returned, worker, run };
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

export function runOrderWorkerHarnessLive(
  db: Database,
  request: HarnessCommandRequest,
  worker: OrderWorker,
  machine: Record<string, string | undefined> | undefined,
  adapter?: HarnessAdapter,
  onAssigned?: (worker: string, sessionId: string, attribution: ExecutionAttribution) => void,
): Promise<Awaited<ReturnType<typeof runHarnessCommandLive>> & { worker?: string }> {
  const env = orderWorkerRequest(db, machine, worker);
  let name = worker.worker;
  const onStarted: HarnessStarted = (sessionId) => {
    if (name) {
      bindOrderWorkerSession(db, worker.orderId, worker.role, sessionId);
    } else {
      const minted = bootstrapWorker(db, {
        id: worker.assignment.id,
        token: worker.assignment.token,
        sessionId,
      });
      saveWorkerCredential(machine ?? process.env, minted);
      bindOrderWorker(db, worker.orderId, worker.role, worker.assignment.id, minted);
      name = minted.name;
    }
    const { tier, model } = route(worker.role, request.harness, machine);
    onAssigned?.(name, sessionId, { harness: request.harness, model, tier });
  };
  const run = worker.providerSessionId
    ? runHarnessCommandResumeLive({ ...request, env }, worker.providerSessionId, onStarted, adapter)
    : runHarnessCommandLive({ ...request, env }, onStarted, adapter);
  return run.then((result) => ({
    ...result,
    worker: name ?? assignedWorker(db, worker.assignment.id) ?? undefined,
  }));
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
      },
      [string, string]
    >(
      `SELECT ow.assignment_id, a.parent_worker, a.role AS assignment_role, a.created_at,
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
  };
}

export function ensureOrderWorker(
  db: Database,
  orderId: string,
  role: StationRole,
  parentWorker: string,
  at = new Date().toISOString(),
): OrderWorker {
  const existing = readOrderWorker(db, orderId, role);
  if (existing) {
    if (existing.worker) {
      return existing;
    }
    return {
      ...existing,
      assignment: renewWorkerAssignment(db, existing.assignment.id),
    };
  }

  return db.transaction(() => {
    const assignment = createWorkerAssignment(db, { parentWorker, role }, at);
    db.run(
      `INSERT INTO factory_order_worker
       (order_id, role, assignment_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [orderId, role, assignment.id, at],
    );
    return { orderId, role, assignment };
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
  if (resolveWorker(db, env) !== orderWorker.worker) {
    throw new Error(`order ${orderWorker.orderId} ${orderWorker.role} worker credential changed identity`);
  }
  return env;
}
