import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { age } from "./age";
import { ORDER_STATUSES, type OrderEventKind, type OrderStatus } from "./factory-order";
import type { OrderLine } from "./order-line";
import { dbPath, tildePath } from "./paths";
import { openReadOnly } from "./read-db";
import { isRole, type Role } from "./roles";
import wallPage from "./wall.html";
import type { ResourceEvidence, WorkerEnvironmentPhase, WorkerHookReport } from "./worker-environment";

export type WallStation = "plan" | "build" | "review" | "ship";
/**
 * How far along the line an order is, which several statuses share: a card can
 * change status without changing column, and reading the stage off the status is
 * what keeps the two from being one list.
 */
export type WallStage = "todo" | "active" | "done";
export type WallRole = Role;

export type WallOrder = {
  id: string;
  title: string;
  line: OrderLine;
  description?: string;
  station: WallStation | null;
  stage: WallStage;
  /** Absent until the order has a moment: the worker is read off the latest one. */
  agent?: string;
  worker?: string;
  /** Absent with the worker and never apart from it: a hand is issued with a role, so an
   *  order that names one names what it was called in as. */
  role?: WallRole;
  /** Never `dropped`: a dropped order leaves the wall, so neither the board nor the item
   *  view ever holds one. */
  status: BoardStatus;
  age: string;
  /** When the order last recorded an event. An order's age on the board is its silence, so it counts
   *  from the last thing that happened rather than from the claim. */
  lastEventAt: string;
  /** How many of the order's checks ended non-zero. An order failing its check repeatedly is
   *  struggling, which is the one piece of evidence a card has room to carry. */
  failedChecks: number;
  /** The hold the order sits on, where it sits on one. An order on a hold is waiting for
   *  something outside the floor, which is what a stopped card says. */
  hold?: string;
};

export type WallSnapshot = {
  generatedAt: string;
  source: "database" | "unavailable";
  orders: WallOrder[];
  totals: Record<WallStage, number>;
};

/** Every kind an order event carries, plus the two kinds of evidence written without one,
 *  named as `dim q order` names them. A changed file is evidence of the same sort but is read
 *  as a set of changes rather than as a moment, so it stands beside the history. */
export type WallItemKind = OrderEventKind | "document_updated" | "environment_reported";

export type WallItemEntry = {
  at: string;
  kind: WallItemKind;
  agent?: string;
  worker?: string;
  /** What the worker on this moment was called in as, so every hand in the history carries
   *  its own role rather than the one the order currently sits under. */
  role?: WallRole;
  station?: WallStation;
  reason?: string;
  hold?: string;
  commit?: { sha: string; subject?: string };
  check?: { command: string; exitCode: number; result?: string };
  finding?: { dimension: string; answer: string; summary: string; resolution?: string };
  path?: string;
  environment?: WorkerHookReport;
};

/** What the order changed in one file, as its recorder counted it. A count is absent where none
 *  was recorded, which a page states as unknown rather than as zero lines changed. */
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
  station: string | null;
  status: string;
  stop_reason: string | null;
  run_id: string | null;
  project: string;
  priority: string;
  hold: string | null;
  last_event_at: string;
  latest_reason: string | null;
  latest_station: string | null;
  holder_worker: string | null;
  holder_role: string | null;
  failed_check_count: number;
};

// Who holds an order is the worker on its latest claim. A move is an operator's audit
// event, not a reassignment, so the latest event cannot stand in for the holder.
const ORDER_ROW_SELECT = `SELECT o.id, o.title, o.line, o.description, o.station, o.status,
              o.stop_reason, o.run_id, o.project, o.priority, o.hold,
              e.ts AS last_event_at, e.reason AS latest_reason, e.station AS latest_station,
              (SELECT e2.worker FROM factory_order_event e2
                WHERE e2.order_id = o.id AND e2.kind = 'claimed'
                ORDER BY e2.ts DESC, e2.id DESC LIMIT 1) AS holder_worker,
              fw.role AS holder_role,
              (SELECT count(*) FROM factory_order_check c
                WHERE c.order_id = o.id AND c.exit_code <> 0) AS failed_check_count
       FROM factory_order o
       LEFT JOIN factory_order_event e ON e.id = (SELECT e2.id FROM factory_order_event e2 WHERE e2.order_id = o.id ORDER BY e2.ts DESC, e2.id DESC LIMIT 1)
       LEFT JOIN factory_worker fw ON fw.name = (SELECT e2.worker FROM factory_order_event e2
         WHERE e2.order_id = o.id AND e2.kind = 'claimed'
         ORDER BY e2.ts DESC, e2.id DESC LIMIT 1)`;

/** A decision not to work is none of `todo`, `active` or `done`, so a dropped order
 *  never reaches `mapOrder`: the snapshot query excludes it and the item view answers
 *  not found, the way it does for an id nothing holds. */
export type BoardStatus = Exclude<OrderStatus, "dropped">;
const WALL_STATUSES = new Set<string>(ORDER_STATUSES.filter((status) => status !== "dropped"));

const stageByStatus: Record<BoardStatus, WallStage> = {
  queued: "todo",
  working: "active",
  completed: "done",
};

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

function station(value: string | null): WallStation | null {
  return value === null ? null : (stationByRecordedValue[value] ?? null);
}

/**
 * The worker's own, never worked out from the station: a worker is called in as one
 * thing and stays it, while the station says where the work is. A hand is issued with a
 * role, so a value this build cannot read is refused rather than drawn as a guess.
 */
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

/** The column is text, so a status this build does not know — dropped included, since it
 *  never reaches this function — is refused rather than drawn. */
function status(value: string): BoardStatus {
  if (!WALL_STATUSES.has(value)) throw new Error(`unknown factory order status: ${value}`);
  return value as BoardStatus;
}

function mapOrder(row: OrderRow, now: Date): WallOrder | null {
  if (row.holder_worker !== null && row.holder_role === null) return null;
  const worker = row.holder_worker;
  const workerRole = worker ? requiredRole(row.holder_role) : undefined;
  const orderStatus = status(row.status);
  const stationName = orderStatus === "completed" ? null : station(row.station ?? row.latest_station);
  // A claim writes its own event in the same transaction, so an order row always has one.
  const lastEventAt = row.last_event_at;
  return {
    id: row.id,
    title: row.title,
    line: row.line as OrderLine,
    ...(row.description ? { description: row.description } : {}),
    station: stationName,
    stage: stageByStatus[orderStatus],
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
  // Ordered by the same clock the card shows, so a column's ages read down the page. An order that
  // needs a person stops recording events, so it sinks under the moving work and would be the
  // first card a bound dropped — it is ranked ahead of the bound rather than after it.
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
  station: string | null;
  hold_type: string | null;
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
  const eventStation = row.station ? station(row.station) : null;

  return {
    at: row.ts,
    kind: row.kind,
    ...(row.worker_id ? { agent: row.worker_id, worker: row.worker_id } : {}),
    ...(role(row.worker_role) ? { role: role(row.worker_role) } : {}),
    ...(eventStation ? { station: eventStation } : {}),
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
  // A dropped order left the wall entirely, so its item view answers not found the same
  // way an id nothing holds does, rather than drawing a card for a stage it is none of.
  if (!row || row.status === "dropped") return null;
  const order = mapOrder(row, now);
  if (!order) return null;
  const events = db
    .query(
      `SELECT e.ts, e.kind, e.worker AS worker_id, fw.role AS worker_role, e.station, e.hold_type, e.reason,
              coalesce(c.sha, e.commit_sha) AS commit_sha, c.subject AS commit_subject,
              ch.command, ch.exit_code, ch.result,
              f.dimension, f.answer, f.summary, f.resolution
       FROM factory_order_event e
       LEFT JOIN factory_worker fw ON fw.name = e.worker
       LEFT JOIN factory_order_commit c ON c.order_id = e.order_id AND c.sha = e.commit_sha
       LEFT JOIN factory_order_check ch ON ch.id = e.check_id AND ch.order_id = e.order_id
       LEFT JOIN factory_order_finding f ON f.id = e.finding_id AND f.order_id = e.order_id
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
  const planRow = db
    .query<
      { revision: number; body: string; worker: string; worker_role: string | null; approved: number },
      [string]
    >(
      `SELECT p.revision, p.body, p.worker, fw.role AS worker_role,
              EXISTS (SELECT 1 FROM factory_order_event e
                WHERE e.order_id = p.order_id AND e.kind = 'plan_approved' AND e.plan_id = p.id) AS approved
       FROM factory_order_plan p
       JOIN factory_worker fw ON fw.name = p.worker
       WHERE p.order_id = ? ORDER BY p.revision DESC, p.id DESC LIMIT 1`,
    )
    .get(orderId);
  const plan = planRow
    ? {
        revision: planRow.revision,
        body: planRow.body,
        worker: planRow.worker,
        role: requiredRole(planRow.worker_role),
        approved: planRow.approved === 1,
      }
    : undefined;
  const buildRow = db
    .query<
      {
        revision: number;
        body: string;
        head_sha: string;
        worker: string;
        worker_role: string | null;
        approved: number;
      },
      [string]
    >(
      `SELECT b.revision, b.body, b.head_sha, b.worker, fw.role AS worker_role,
              EXISTS (SELECT 1 FROM factory_order_event e
                WHERE e.order_id = b.order_id AND e.kind = 'build_approved' AND e.commit_sha = b.head_sha) AS approved
       FROM factory_order_build b
       JOIN factory_worker fw ON fw.name = b.worker
       WHERE b.order_id = ? ORDER BY b.revision DESC, b.id DESC LIMIT 1`,
    )
    .get(orderId);
  const build = buildRow
    ? {
        revision: buildRow.revision,
        body: buildRow.body,
        headSha: buildRow.head_sha,
        worker: buildRow.worker,
        role: requiredRole(buildRow.worker_role),
        approved: buildRow.approved === 1,
      }
    : undefined;
  const reviewRow = db
    .query<
      { revision: number; body: string; worker: string; worker_role: string | null; approved: number },
      [string]
    >(
      `SELECT a.revision, a.body, a.worker, fw.role AS worker_role,
              EXISTS (SELECT 1 FROM factory_order_event e
                WHERE e.order_id = a.order_id AND e.kind = 'review_approved' AND e.review_id = a.review_id) AS approved
       FROM factory_order_review_artifact a
       JOIN factory_worker fw ON fw.name = a.worker
       WHERE a.order_id = ? ORDER BY a.id DESC LIMIT 1`,
    )
    .get(orderId);
  const review = reviewRow
    ? {
        revision: reviewRow.revision,
        body: reviewRow.body,
        worker: reviewRow.worker,
        role: requiredRole(reviewRow.worker_role),
        approved: reviewRow.approved === 1,
      }
    : undefined;
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
    // Two rows recorded at the same instant carry nothing that says which was written first,
    // so they hold the order `dim q order` puts them in — events, then documents and
    // environment reports — rather than the two surfaces disagreeing on a tie.
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
  }, 1000);
  poll.unref();
  return server;
}
