import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { age } from "./age";
import type { OrderEventKind } from "./factory-events";
import { ORDER_STATUSES, type OrderStatus } from "./factory-order-status";
import type { OrderLine } from "./order-line";
import { dbPath, tildePath } from "./paths";
import { openReadOnly } from "./read-db";
import { isRole, type Role } from "./roles";
import type { Station } from "./station";
import wallPage from "./wall.html";
import type { ResourceEvidence, WorkerEnvironmentPhase, WorkerHookReport } from "./worker-environment";

export type WallStage = "todo" | "active" | "done";
export type WallRole = Role;

export type WallOrder = {
  id: string;
  title: string;
  line: OrderLine;
  description?: string;
  station: Station | null;
  stage: WallStage;
  agent?: string;
  worker?: string;
  role?: WallRole;
  status: BoardStatus;
  age: string;
  lastEventAt: string;
  failedChecks: number;
  hold?: string;
};

export type WallSnapshot = {
  generatedAt: string;
  source: "database" | "unavailable";
  orders: WallOrder[];
  totals: Record<WallStage, number>;
};

export type WallItemKind = OrderEventKind | "document_updated" | "environment_reported";

export type WallItemEntry = {
  at: string;
  kind: WallItemKind;
  agent?: string;
  worker?: string;
  role?: WallRole;
  station?: Station;
  reason?: string;
  hold?: string;
  commit?: { sha: string; subject?: string };
  check?: { command: string; exitCode: number; result?: string };
  finding?: { dimension: string; answer: string; failure: string; resolution?: string };
  path?: string;
  environment?: WorkerHookReport;
};

export type WallItemChange = {
  path: string;
  added?: number;
  removed?: number;
};

export type WallPlan = {
  revision: number;
  body: string;
  worker: string;
  role: WallRole;
  approved: boolean;
};

export type WallBuild = {
  revision: number;
  body: string;
  headSha: string;
  worker: string;
  role: WallRole;
  approved: boolean;
};

export type WallReview = {
  revision: number;
  body: string;
  worker: string;
  role: WallRole;
  approved: boolean;
};

export type WallItemView = {
  order: WallOrder;
  runId?: string;
  project: string;
  plan?: WallPlan;
  build?: WallBuild;
  review?: WallReview;
  entries: WallItemEntry[];
  changes: WallItemChange[];
};

const MAX_COLUMN_CARDS = 12;

type OrderRow = {
  id: string;
  title: string;
  line: string;
  description: string | null;
  station: Station | null;
  status: string;
  stop_reason: string | null;
  run_id: string | null;
  project: string;
  priority: string;
  hold: string | null;
  last_event_at: string;
  latest_reason: string | null;
  holder_worker: string | null;
  holder_role: string | null;
  has_started: number;
  failed_check_count: number;
};

const ORDER_ROW_SELECT = `SELECT o.id, o.title, o.line, o.description, o.station, o.status,
              o.stop_reason, o.run_id, o.project, o.priority, o.hold,
              e.ts AS last_event_at, e.reason AS latest_reason,
              (SELECT e2.worker FROM factory_order_event e2
                WHERE e2.order_id = o.id AND e2.kind = 'claimed'
                ORDER BY e2.ts DESC, e2.id DESC LIMIT 1) AS holder_worker,
              fw.role AS holder_role,
              EXISTS (SELECT 1 FROM factory_order_event e2
                WHERE e2.order_id = o.id AND e2.kind = 'claimed') AS has_started,
              (SELECT count(*) FROM factory_order_check c
                WHERE c.order_id = o.id AND c.exit_code <> 0) AS failed_check_count
       FROM factory_order o
       LEFT JOIN factory_order_event e ON e.id = (SELECT e2.id FROM factory_order_event e2 WHERE e2.order_id = o.id ORDER BY e2.ts DESC, e2.id DESC LIMIT 1)
       LEFT JOIN factory_worker fw ON fw.name = (SELECT e2.worker FROM factory_order_event e2
         WHERE e2.order_id = o.id AND e2.kind = 'claimed'
         ORDER BY e2.ts DESC, e2.id DESC LIMIT 1)`;

export type BoardStatus = Exclude<OrderStatus, "dropped">;
const WALL_STATUSES = new Set<string>(ORDER_STATUSES.filter((status) => status !== "dropped"));

const stageByStatus: Record<BoardStatus, WallStage> = {
  queued: "todo",
  working: "active",
  completed: "done",
};

function role(value: string | null): WallRole | undefined {
  if (value === null) return undefined;
  if (!isRole(value)) throw new Error(`unknown factory worker role: ${value}`);
  return value;
}

function requiredRole(value: string | null): WallRole {
  const workerRole = role(value);
  if (!workerRole) throw new Error("factory worker role is missing");
  return workerRole;
}

function status(value: string): BoardStatus {
  if (!WALL_STATUSES.has(value)) throw new Error(`unknown factory order status: ${value}`);
  return value as BoardStatus;
}

function mapOrder(row: OrderRow, now: Date): WallOrder | null {
  if (row.holder_worker !== null && row.holder_role === null) return null;
  const worker = row.holder_worker;
  const workerRole = worker ? requiredRole(row.holder_role) : undefined;
  const orderStatus = status(row.status);
  const baseStage = stageByStatus[orderStatus];
  const lastEventAt = row.last_event_at;
  return {
    id: row.id,
    title: row.title,
    line: row.line as OrderLine,
    ...(row.description ? { description: row.description } : {}),
    station: orderStatus === "completed" ? null : row.station,
    stage: baseStage === "done" ? baseStage : row.has_started ? "active" : baseStage,
    ...(worker ? { agent: worker, worker } : {}),
    ...(workerRole ? { role: workerRole } : {}),
    status: orderStatus,
    age: age(lastEventAt, now),
    lastEventAt,
    failedChecks: row.failed_check_count,
    ...(row.hold ? { hold: row.hold } : {}),
  };
}

export function assembleWallSnapshot(db: Database, now = new Date()): WallSnapshot {
  const rows = db
    .query(`${ORDER_ROW_SELECT} WHERE o.status <> 'dropped' ORDER BY e.ts DESC, o.id`)
    .all() as OrderRow[];
  const mapped = rows.map((row) => mapOrder(row, now)).filter((order): order is WallOrder => order !== null);
  const totals: Record<WallStage, number> = { todo: 0, active: 0, done: 0 };
  const orders: WallOrder[] = [];
  for (const order of mapped) {
    totals[order.stage] += 1;
    if (totals[order.stage] <= MAX_COLUMN_CARDS) orders.push(order);
  }
  return { generatedAt: now.toISOString(), source: "database", orders, totals };
}

type EventRow = {
  ts: string;
  kind: WallItemKind;
  worker_id: string | null;
  worker_role: string | null;
  station: Station | null;
  hold_type: string | null;
  reason: string | null;
  commit_sha: string | null;
  commit_subject: string | null;
  command: string | null;
  exit_code: number | null;
  result: string | null;
  dimension: string | null;
  answer: string | null;
  failure: string | null;
  resolution: string | null;
};

type PathRow = { recorded_at: string; worker_id: string; worker_role: string | null; path: string };

type FileRow = { path: string; added: number | null; removed: number | null };

type EnvironmentRow = {
  recorded_at: string;
  phase: WorkerEnvironmentPhase;
  argv: string;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  resources: string;
};

function storedList<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function environmentEntry(row: EnvironmentRow): WallItemEntry {
  return {
    at: row.recorded_at,
    kind: "environment_reported",
    environment: {
      phase: row.phase,
      argv: storedList<string>(row.argv),
      exitCode: row.exit_code,
      signal: row.signal,
      stdout: row.stdout,
      stderr: row.stderr,
      resources: storedList<ResourceEvidence>(row.resources),
    },
  };
}

function eventEntry(row: EventRow): WallItemEntry {
  return {
    at: row.ts,
    kind: row.kind,
    ...(row.worker_id ? { agent: row.worker_id, worker: row.worker_id } : {}),
    ...(role(row.worker_role) ? { role: role(row.worker_role) } : {}),
    ...(row.station ? { station: row.station } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.hold_type ? { hold: row.hold_type } : {}),
    ...(row.commit_sha
      ? { commit: { sha: row.commit_sha, ...(row.commit_subject ? { subject: row.commit_subject } : {}) } }
      : {}),
    ...(row.command !== null && row.exit_code !== null
      ? {
          check: {
            command: row.command,
            exitCode: row.exit_code,
            ...(row.result ? { result: row.result } : {}),
          },
        }
      : {}),
    ...(row.dimension && row.answer && row.failure !== null
      ? {
          finding: {
            dimension: row.dimension,
            answer: row.answer,
            failure: row.failure,
            ...(row.resolution ? { resolution: row.resolution } : {}),
          },
        }
      : {}),
  };
}

function artifactPanel(db: Database, orderId: string, kind: "plan" | "build" | "review") {
  const row = db
    .query<
      {
        revision: number;
        body: string;
        head_sha: string | null;
        worker: string;
        worker_role: string | null;
        approved: number;
      },
      [string, string]
    >(
      `SELECT a.revision, a.body, a.head_sha, w.worker, fw.role AS worker_role,
              EXISTS (SELECT 1 FROM factory_order_event e
                WHERE e.kind = 'artifact_approved' AND e.artifact_id = a.id) AS approved
       FROM factory_order_artifact a
       JOIN factory_order_event w ON w.artifact_id = a.id AND w.kind = 'artifact_written'
       JOIN factory_worker fw ON fw.name = w.worker
       WHERE a.order_id = ? AND a.kind = ? ORDER BY a.revision DESC LIMIT 1`,
    )
    .get(orderId, kind);
  if (!row) return undefined;
  return {
    headSha: row.head_sha,
    panel: {
      revision: row.revision,
      body: row.body,
      worker: row.worker,
      role: requiredRole(row.worker_role),
      approved: row.approved === 1,
    },
  };
}

export function assembleItemView(db: Database, orderId: string, now = new Date()): WallItemView | null {
  const row = db.query(`${ORDER_ROW_SELECT} WHERE o.id = ?`).get(orderId) as OrderRow | null;
  if (!row || row.status === "dropped") return null;
  const order = mapOrder(row, now);
  if (!order) return null;
  const events = db
    .query(
      `SELECT e.ts, e.kind, e.worker AS worker_id, fw.role AS worker_role,
              coalesce(art.kind, e.station) AS station, e.hold_type, e.reason,
              coalesce(c.sha, e.commit_sha, art.head_sha) AS commit_sha, c.subject AS commit_subject,
              ch.command, ch.exit_code, ch.result,
              f.dimension, a.answer, f.failure, a.resolution
       FROM factory_order_event e
       LEFT JOIN factory_worker fw ON fw.name = e.worker
       LEFT JOIN factory_order_artifact art ON art.id = e.artifact_id
       LEFT JOIN factory_order_commit c ON c.order_id = e.order_id AND c.sha = e.commit_sha
       LEFT JOIN factory_order_check ch ON ch.id = e.check_id AND ch.order_id = e.order_id
       LEFT JOIN factory_order_finding f ON f.id = e.finding_id
       LEFT JOIN factory_order_finding_answer a ON a.id = e.answer_id
       WHERE e.order_id = ? ORDER BY e.ts, e.id`,
    )
    .all(orderId) as EventRow[];
  const files = db
    .query(
      `SELECT path, added, removed FROM factory_order_file
       WHERE order_id = ? ORDER BY recorded_at, path`,
    )
    .all(orderId) as FileRow[];
  const documents = db
    .query(
      `SELECT d.recorded_at, d.worker AS worker_id, fw.role AS worker_role, d.path
       FROM factory_order_document d
       LEFT JOIN factory_worker fw ON fw.name = d.worker
       WHERE d.order_id = ? ORDER BY d.recorded_at, d.path`,
    )
    .all(orderId) as PathRow[];
  const environments = db
    .query(
      `SELECT recorded_at, phase, argv, exit_code, signal, stdout, stderr, resources
       FROM factory_order_environment WHERE order_id = ? ORDER BY recorded_at, id`,
    )
    .all(orderId) as EnvironmentRow[];
  const plan = artifactPanel(db, orderId, "plan")?.panel;
  const built = artifactPanel(db, orderId, "build");
  const build = built ? { ...built.panel, headSha: built.headSha as string } : undefined;
  const review = artifactPanel(db, orderId, "review")?.panel;
  const entries: WallItemEntry[] = [
    ...events.map(eventEntry),
    ...documents.map((doc) => ({
      at: doc.recorded_at,
      kind: "document_updated" as const,
      worker: doc.worker_id,
      ...(role(doc.worker_role) ? { role: role(doc.worker_role) } : {}),
      path: tildePath(doc.path),
    })),
    ...environments.map(environmentEntry),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    order,
    ...(row.run_id ? { runId: row.run_id } : {}),
    project: row.project,
    ...(plan ? { plan } : {}),
    ...(build ? { build } : {}),
    ...(review ? { review } : {}),
    entries,
    changes: files.map((file) => ({
      path: tildePath(file.path),
      ...(file.added === null ? {} : { added: file.added }),
      ...(file.removed === null ? {} : { removed: file.removed }),
    })),
  };
}

function orderIdIn(pathname: string): string | null {
  const raw = pathname.slice("/api/order/".length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function wallFont(): Uint8Array {
  return new Uint8Array(readFileSync(new URL("./fonts/jetbrains-mono-latin.woff2", import.meta.url)));
}

type WallSocket = Pick<Bun.ServerWebSocket<undefined>, "send">;

export function wallHandler(path: string = dbPath()) {
  const font = wallFont();
  const clients = new Set<WallSocket>();
  const snapshot = (): WallSnapshot => {
    const db = openReadOnly(path);
    try {
      return assembleWallSnapshot(db, new Date());
    } finally {
      db.close();
    }
  };
  const item = (orderId: string): WallItemView | null => {
    const db = openReadOnly(path);
    try {
      return assembleItemView(db, orderId, new Date());
    } finally {
      db.close();
    }
  };
  return {
    clients,
    snapshot,
    fetch(request: Request, server: Pick<Bun.Server<undefined>, "upgrade">): Response | undefined {
      const url = new URL(request.url);
      if (url.pathname === "/wall.woff2")
        return new Response(font as unknown as BodyInit, {
          headers: { "content-type": "font/woff2", "cache-control": "max-age=31536000, immutable" },
        });
      if (url.pathname === "/api/snapshot") {
        try {
          return Response.json(snapshot(), { headers: { "cache-control": "no-store" } });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 503 },
          );
        }
      }
      if (url.pathname.startsWith("/api/order/")) {
        const orderId = orderIdIn(url.pathname);
        if (orderId === null) return new Response("Not found", { status: 404 });
        try {
          const view = item(orderId);
          if (!view) return new Response("Not found", { status: 404 });
          return Response.json(view, { headers: { "cache-control": "no-store" } });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 503 },
          );
        }
      }
      if (url.pathname === "/api/control") return new Response("Not found", { status: 404 });
      if (url.pathname === "/ws" && server.upgrade(request)) return;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(socket: WallSocket) {
        clients.add(socket);
      },
      close(socket: WallSocket) {
        clients.delete(socket);
      },
      message(socket: WallSocket) {
        socket.send(JSON.stringify({ error: "read-only wall" }));
      },
    },
  };
}

export async function serveWall(
  options: { port?: number; databasePath?: string; hmr?: boolean } = {},
): Promise<ReturnType<typeof Bun.serve>> {
  const { clients, snapshot, fetch, websocket } = wallHandler(options.databasePath);
  let hash = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    routes: { "/": wallPage },
    development: options.hmr ? { hmr: true } : false,
    fetch,
    websocket,
  });
  const poll = setInterval(() => {
    if (clients.size === 0) return;
    try {
      const current = snapshot();
      const nextHash = Bun.hash(JSON.stringify(current)).toString(16);
      if (nextHash === hash) return;
      hash = nextHash;
      for (const client of clients) client.send(JSON.stringify(current));
    } catch {
      for (const client of clients) client.send(JSON.stringify({ error: "snapshot unavailable" }));
    }
  }, 1000);
  poll.unref();
  return server;
}
