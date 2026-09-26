import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { openReadOnly } from "./db-read";
import { runningAttempt } from "./order-attempt";
import type { OrderEventKind } from "./order-events";
import type { OrderLine } from "./order-line";
import { type NextAct, orderState } from "./order-state";
import { type OrderStatus, orderStatusSql } from "./order-status";
import { dbPath } from "./paths";
import type { Station } from "./station";
import wallPage from "./wall.html";
import type { Role } from "./worker-roles";

export type WallStage = "todo" | "active" | "done";

export type WallWorker = { name: string; role: Role };

export type WallOrder = {
  id: string;
  title: string;
  line: OrderLine;
  description: string | null;
  station: Station | null;
  stage: WallStage;
  worker: WallWorker | null;
  status: BoardStatus;
  lastEventAt: string;
  next: NextAct | null;
};

export type WallSnapshot = {
  generatedAt: string;
  orders: WallOrder[];
  totals: Record<WallStage, number>;
};

export type WallItemKind = OrderEventKind | "environment_reported";

export type WallItemEntry = {
  at: string;
  kind: WallItemKind;
  station: Station | null;
  worker: WallWorker | null;
};

export type WallArtifact = {
  revision: number;
  body: string;
  worker: WallWorker;
  approved: boolean;
};

export type WallItemView = {
  order: WallOrder;
  project: string;
  plan: WallArtifact | null;
  build: WallArtifact | null;
  review: WallArtifact | null;
  entries: WallItemEntry[];
};

const MAX_COLUMN_CARDS = 12;

type OrderRow = {
  id: string;
  title: string;
  line: OrderLine;
  description: string | null;
  status: OrderStatus;
  project: string;
  last_event_at: string;
};

const ORDER_ROW_SELECT = `SELECT o.id, o.title, o.line, o.description, ${orderStatusSql("o.id")} AS status,
              o.project, e.ts AS last_event_at
       FROM factory_order o
       LEFT JOIN factory_order_event e ON e.id = (SELECT e2.id FROM factory_order_event e2 WHERE e2.order_id = o.id ORDER BY e2.ts DESC, e2.id DESC LIMIT 1)`;
export type BoardStatus = Exclude<OrderStatus, "dropped">;

type BoardRow = OrderRow & { status: BoardStatus };

const stageByStatus: Record<BoardStatus, WallStage> = {
  queued: "todo",
  active: "active",
  done: "done",
};

function mapOrder(db: Database, row: BoardRow): WallOrder {
  const active = row.status === "active";
  const state = active ? orderState(db, row.id) : null;
  const attempt = active ? runningAttempt(db, row.id) : null;
  return {
    id: row.id,
    title: row.title,
    line: row.line,
    description: row.description,
    station: state === null ? null : state.station,
    stage: stageByStatus[row.status],
    worker: attempt ? { name: attempt.worker, role: attempt.role } : null,
    status: row.status,
    lastEventAt: row.last_event_at,
    next: state === null ? null : state.next,
  };
}

export function assembleWallSnapshot(db: Database, now = new Date()): WallSnapshot {
  const rows = db
    .query<BoardRow, []>(
      `${ORDER_ROW_SELECT} WHERE ${orderStatusSql("o.id")} <> 'dropped' ORDER BY e.ts DESC, o.id`,
    )
    .all();
  const mapped = rows.map((row) => mapOrder(db, row));
  const totals: Record<WallStage, number> = { todo: 0, active: 0, done: 0 };
  const orders: WallOrder[] = [];
  for (const order of mapped) {
    totals[order.stage] += 1;
    if (totals[order.stage] <= MAX_COLUMN_CARDS) orders.push(order);
  }
  return { generatedAt: now.toISOString(), orders, totals };
}

type EventRow = {
  ts: string;
  kind: WallItemKind;
  worker_id: string | null;
  worker_role: Role | null;
  station: Station | null;
};

function eventEntry(row: EventRow): WallItemEntry {
  return {
    at: row.ts,
    kind: row.kind,
    station: row.station,
    worker: row.worker_id && row.worker_role ? { name: row.worker_id, role: row.worker_role } : null,
  };
}

function artifactPanel(
  db: Database,
  orderId: string,
  kind: "plan" | "build" | "review",
): WallArtifact | null {
  const row = db
    .query<
      { revision: number; body: string; worker: string; worker_role: Role; approved: number },
      [string, string]
    >(
      `SELECT a.revision, a.body, w.worker, fw.role AS worker_role,
              EXISTS (SELECT 1 FROM factory_order_event e
                WHERE e.kind = 'artifact_approved' AND e.artifact_id = a.id) AS approved
       FROM factory_order_artifact a
       JOIN factory_order_event w ON w.artifact_id = a.id AND w.kind = 'artifact_written'
       JOIN factory_worker fw ON fw.name = w.worker
       WHERE a.order_id = ? AND a.kind = ? ORDER BY a.revision DESC LIMIT 1`,
    )
    .get(orderId, kind);
  if (!row) return null;
  return {
    revision: row.revision,
    body: row.body,
    worker: { name: row.worker, role: row.worker_role },
    approved: row.approved === 1,
  };
}

export function assembleItemView(db: Database, orderId: string): WallItemView | null {
  const row = db.query<OrderRow, [string]>(`${ORDER_ROW_SELECT} WHERE o.id = ?`).get(orderId);
  if (!row || row.status === "dropped") return null;
  const events = db
    .query<EventRow, [string]>(
      `SELECT e.ts, e.kind, e.worker AS worker_id, fw.role AS worker_role,
              coalesce(art.kind, e.station) AS station
       FROM factory_order_event e
       LEFT JOIN factory_worker fw ON fw.name = e.worker
       LEFT JOIN factory_order_artifact art ON art.id = e.artifact_id
       WHERE e.order_id = ? ORDER BY e.ts, e.id`,
    )
    .all(orderId);
  const environments = db
    .query<{ recorded_at: string }, [string]>(
      "SELECT recorded_at FROM factory_order_environment WHERE order_id = ? ORDER BY recorded_at, id",
    )
    .all(orderId);
  const entries: WallItemEntry[] = [
    ...events.map(eventEntry),
    ...environments.map(
      (environment): WallItemEntry => ({
        at: environment.recorded_at,
        kind: "environment_reported",
        station: null,
        worker: null,
      }),
    ),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    order: mapOrder(db, { ...row, status: row.status }),
    project: row.project,
    plan: artifactPanel(db, orderId, "plan"),
    build: artifactPanel(db, orderId, "build"),
    review: artifactPanel(db, orderId, "review"),
    entries,
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
      return assembleItemView(db, orderId);
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
