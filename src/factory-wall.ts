import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { age } from "./age";
import type { OrderEventKind } from "./factory-order";
import { dbPath, tildePath } from "./paths";
import { openReadOnly } from "./read-db";
import wallPage from "./wall.html";
import type { ResourceEvidence, WorkerEnvironmentPhase, WorkerHookReport } from "./worker-environment";
import { workerName } from "./worker-name";

export type WallStation = "plan" | "build" | "review" | "ship" | "unknown";
export type WallPhase = "todo" | "active" | "done";
export type WallStatus = "running" | "waiting" | "blocked" | "fenced" | "completed" | "failed" | "abandoned";
export type WallRole = "builder" | "reviewer" | "planner" | "unknown";

export type WallOrder = {
  id: string;
  title: string;
  itemId: string;
  station: WallStation;
  phase: WallPhase;
  /** Absent where no claim and no event named an agent: an order nobody is recorded against. */
  agent?: string;
  /** What the floor calls this worker, so a card never shows an internal identity. */
  worker?: string;
  role: WallRole;
  status: WallStatus;
  age: string;
  /** When the order last recorded an event. An order's age on the board is its silence, so it counts
   *  from the last thing that happened rather than from the claim. */
  lastEventAt: string;
  /** How many of the order's checks ended non-zero. An order failing its check repeatedly is
   *  struggling, which is the one piece of evidence a card has room to carry. */
  failedChecks: number;
  attention?: string;
};

export type WallSnapshot = {
  generatedAt: string;
  source: "database" | "unavailable";
  orders: WallOrder[];
  totals: Record<WallPhase, number>;
};

/** Every kind an order event carries, plus the three kinds of evidence written without one,
 *  named as `dim q order` names them. */
export type WallItemKind = OrderEventKind | "file_changed" | "document_updated" | "environment_reported";

export type WallItemEntry = {
  at: string;
  kind: WallItemKind;
  agent?: string;
  worker?: string;
  station?: WallStation;
  reason?: string;
  fence?: string;
  delegatedTo?: { agent: string; worker: string; station?: WallStation };
  commit?: { sha: string; subject?: string };
  check?: { command: string; exitCode: number; result?: string };
  finding?: { dimension: string; answer: string; summary: string; resolution?: string };
  path?: string;
  environment?: WorkerHookReport;
};

export type WallItemView = {
  order: WallOrder;
  runId: string;
  queueId: string;
  worktree?: string;
  branch?: string;
  entries: WallItemEntry[];
};

const MAX_COLUMN_CARDS = 12;

type OrderRow = {
  id: string;
  item_id: string;
  title: string;
  agent_id: string | null;
  role: string | null;
  station: string | null;
  status: string;
  stop_reason: string | null;
  run_id: string;
  queue_id: string;
  worktree: string | null;
  branch: string | null;
  last_event_at: string;
  latest_reason: string | null;
  latest_station: string | null;
  latest_actor: string | null;
  failed_check_count: number;
};

const ORDER_ROW_SELECT = `SELECT o.id, o.item_id, o.title, o.agent_id, o.role, o.station, o.status,
              o.stop_reason, o.run_id, o.queue_id, o.worktree, o.branch,
              e.ts AS last_event_at, e.reason AS latest_reason, e.station AS latest_station,
              e.actor_id AS latest_actor,
              (SELECT count(*) FROM factory_order_check c
                WHERE c.order_id = o.id AND c.exit_code <> 0) AS failed_check_count
       FROM factory_order o
       LEFT JOIN factory_order_event e ON e.id = (SELECT e2.id FROM factory_order_event e2 WHERE e2.order_id = o.id ORDER BY e2.ts DESC, e2.id DESC LIMIT 1)`;

const wallStatusByOrderStatus: Record<string, WallStatus> = {
  claimed: "waiting",
  running: "running",
  blocked: "blocked",
  fenced: "fenced",
  completed: "completed",
  failed: "failed",
  abandoned: "abandoned",
};

const phaseByStatus: Record<WallStatus, WallPhase> = {
  waiting: "todo",
  running: "active",
  blocked: "active",
  fenced: "active",
  completed: "done",
  failed: "done",
  abandoned: "done",
};

const attentionStatuses = new Set<WallStatus>(["blocked", "fenced", "failed", "abandoned"]);

// An order is claimed with whatever word the caller passed, and a line or a typo is not a station.
// Naming one of the four for a value that is none of them puts a card at a station nobody sent
// it to, which is worse than the card saying it does not know.
const stationByRecordedValue: Record<string, WallStation> = {
  plan: "plan",
  "dim-station-plan": "plan",
  build: "build",
  "dim-station-build": "build",
  review: "review",
  "dim-station-review": "review",
  ship: "ship",
  "dim-station-ship": "ship",
};

function station(value: string | null): WallStation {
  return (value === null ? undefined : stationByRecordedValue[value]) ?? "unknown";
}

/**
 * Read from the claim, never worked out from the station: a worker is called in as one
 * thing and stays it, while the station says where the work is. A role the record does
 * not hold reads as unknown rather than as whatever the station suggests.
 */
function role(value: string | null): WallRole {
  return value === "planner" || value === "builder" || value === "reviewer" ? value : "unknown";
}

function status(value: string): WallStatus {
  const mapped = wallStatusByOrderStatus[value];
  if (!mapped) throw new Error(`unknown factory order status: ${value}`);
  return mapped;
}

function mapOrder(row: OrderRow, now: Date): WallOrder {
  const agentId = row.latest_actor ?? row.agent_id;
  const stationName = station(row.station ?? row.latest_station);
  const orderStatus = status(row.status);
  const attention = attentionStatuses.has(orderStatus)
    ? (row.stop_reason ?? row.latest_reason ?? orderStatus)
    : undefined;
  // A claim writes its own event in the same transaction, so an order row always has one.
  const lastEventAt = row.last_event_at;
  return {
    id: row.id,
    title: row.title,
    itemId: row.item_id,
    station: stationName,
    phase: phaseByStatus[orderStatus],
    ...(agentId ? { agent: agentId, worker: workerName(agentId) } : {}),
    role: role(row.role),
    status: orderStatus,
    age: age(lastEventAt, now),
    lastEventAt,
    failedChecks: row.failed_check_count,
    ...(attention ? { attention } : {}),
  };
}

export function assembleWallSnapshot(db: Database, now = new Date()): WallSnapshot {
  // Ordered by the same clock the card shows, so a column's ages read down the page. An order that
  // needs a person stops recording events, so it sinks under the moving work and would be the
  // first card a bound dropped — it is ranked ahead of the bound rather than after it.
  const rows = db.query(`${ORDER_ROW_SELECT} ORDER BY e.ts DESC, o.id`).all() as OrderRow[];
  const mapped = rows.map((row) => mapOrder(row, now));
  const totals: Record<WallPhase, number> = { todo: 0, active: 0, done: 0 };
  const orders: WallOrder[] = [];
  for (const order of [
    ...mapped.filter((order) => order.attention),
    ...mapped.filter((order) => !order.attention),
  ]) {
    totals[order.phase] += 1;
    if (totals[order.phase] <= MAX_COLUMN_CARDS) orders.push(order);
  }
  return { generatedAt: now.toISOString(), source: "database", orders, totals };
}

type EventRow = {
  ts: string;
  kind: WallItemKind;
  actor_id: string | null;
  station: string | null;
  delegated_agent_id: string | null;
  delegated_station: string | null;
  fence_type: string | null;
  reason: string | null;
  commit_sha: string | null;
  commit_subject: string | null;
  command: string | null;
  exit_code: number | null;
  result: string | null;
  dimension: string | null;
  answer: string | null;
  summary: string | null;
  resolution: string | null;
};

type PathRow = { recorded_at: string; path: string };

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

/** `argv` and `resources` are stored as the JSON the hook reported. A row whose JSON no longer
 *  parses is a row the wall cannot describe, so it stands as an empty list rather than
 *  stopping the view that holds it. */
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
    ...(row.actor_id ? { agent: row.actor_id, worker: workerName(row.actor_id) } : {}),
    ...(row.station ? { station: station(row.station) } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.fence_type ? { fence: row.fence_type } : {}),
    ...(row.delegated_agent_id
      ? {
          delegatedTo: {
            agent: row.delegated_agent_id,
            worker: workerName(row.delegated_agent_id),
            ...(row.delegated_station ? { station: station(row.delegated_station) } : {}),
          },
        }
      : {}),
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
    ...(row.dimension && row.answer && row.summary !== null
      ? {
          finding: {
            dimension: row.dimension,
            answer: row.answer,
            summary: row.summary,
            ...(row.resolution ? { resolution: row.resolution } : {}),
          },
        }
      : {}),
  };
}

/** One order's own record: the identity a card carries, and every lifecycle event and piece of
 *  evidence, ordered by the time each was recorded. Commits, checks and findings are written
 *  with the event that produced them, so they arrive attached rather than listed a second
 *  time. */
export function assembleItemView(db: Database, orderId: string, now = new Date()): WallItemView | null {
  const row = db.query(`${ORDER_ROW_SELECT} WHERE o.id = ?`).get(orderId) as OrderRow | null;
  if (!row) return null;
  const events = db
    .query(
      `SELECT e.ts, e.kind, e.actor_id, e.station, e.delegated_agent_id, e.delegated_station,
              e.fence_type, e.reason,
              coalesce(c.sha, e.commit_sha) AS commit_sha, c.subject AS commit_subject,
              ch.command, ch.exit_code, ch.result,
              f.dimension, f.answer, f.summary, f.resolution
       FROM factory_order_event e
       LEFT JOIN factory_order_commit c ON c.order_id = e.order_id AND c.sha = e.commit_sha
       LEFT JOIN factory_order_check ch ON ch.id = e.check_id AND ch.order_id = e.order_id
       LEFT JOIN factory_order_finding f ON f.id = e.finding_id AND f.order_id = e.order_id
       WHERE e.order_id = ? ORDER BY e.ts, e.id`,
    )
    .all(orderId) as EventRow[];
  const files = db
    .query("SELECT recorded_at, path FROM factory_order_file WHERE order_id = ? ORDER BY recorded_at, path")
    .all(orderId) as PathRow[];
  const documents = db
    .query(
      "SELECT recorded_at, path FROM factory_order_document WHERE order_id = ? ORDER BY recorded_at, path",
    )
    .all(orderId) as PathRow[];
  const environments = db
    .query(
      `SELECT recorded_at, phase, argv, exit_code, signal, stdout, stderr, resources
       FROM factory_order_environment WHERE order_id = ? ORDER BY recorded_at, id`,
    )
    .all(orderId) as EnvironmentRow[];
  const entries: WallItemEntry[] = [
    ...events.map(eventEntry),
    ...files.map((file) => ({
      at: file.recorded_at,
      kind: "file_changed" as const,
      path: tildePath(file.path),
    })),
    ...documents.map((doc) => ({
      at: doc.recorded_at,
      kind: "document_updated" as const,
      path: tildePath(doc.path),
    })),
    ...environments.map(environmentEntry),
    // Two rows recorded at the same instant carry nothing that says which was written first,
    // so they hold the order `dim q order` puts them in — events, then files, documents and
    // environment reports — rather than the two surfaces disagreeing on a tie.
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    order: mapOrder(row, now),
    runId: row.run_id,
    queueId: row.queue_id,
    ...(row.worktree ? { worktree: tildePath(row.worktree) } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    entries,
  };
}

/** The order id a request names, or nothing where the path holds a percent sequence that is not
 *  valid UTF-8: an id the page cannot spell is an id this server holds no order for. */
function orderIdIn(pathname: string): string | null {
  const raw = pathname.slice("/api/order/".length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** The face the page asks for, read off disk so nothing on this wall reaches the network. */
export function wallFont(): Uint8Array {
  return new Uint8Array(readFileSync(new URL("./fonts/jetbrains-mono-latin.woff2", import.meta.url)));
}

export async function serveWall(
  options: { port?: number; databasePath?: string; hmr?: boolean } = {},
): Promise<ReturnType<typeof Bun.serve>> {
  const font = wallFont();
  const clients = new Set<Bun.ServerWebSocket<unknown>>();
  const path = options.databasePath ?? dbPath();
  let hash = "";
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
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    // The page and every asset it pulls are bundled from this route, so the wall has one
    // way of being served and `hmr` is the only thing an editing session changes.
    routes: { "/": wallPage },
    development: options.hmr ? { hmr: true } : false,
    fetch(request, server) {
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
      open(socket) {
        clients.add(socket);
      },
      close(socket) {
        clients.delete(socket);
      },
      message(socket) {
        socket.send(JSON.stringify({ error: "read-only wall" }));
      },
    },
  });
  // Bun.serve already holds the event loop; an unref'd poller lets a stopped server's process exit.
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
  }, 2000);
  poll.unref();
  return server;
}
