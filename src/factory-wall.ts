import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { age } from "./age";
import { dbPath } from "./paths";
import { openReadOnly } from "./read-db";
import wallPage from "./wall.html";
import { workerName } from "./worker-name";

export type WallStation = "plan" | "build" | "review" | "ship";
export type WallLifecycle = "todo" | "active" | "done";
export type WallStatus = "running" | "waiting" | "blocked" | "fenced" | "completed" | "failed" | "abandoned";
export type WallRole = "builder" | "fixer" | "reviewer" | "planner";

export type WallJob = {
  id: string;
  title: string;
  itemId: string;
  station: WallStation;
  lifecycle: WallLifecycle;
  agent: string;
  /** What the floor calls this worker, so a card never shows an internal identity. */
  worker: string;
  role: WallRole;
  status: WallStatus;
  action: string;
  age: string;
  updatedAt: string;
  evidence: string;
  attention?: string;
};

export type WallSnapshot = {
  generatedAt: string;
  source: "database" | "unavailable";
  jobs: WallJob[];
  totals: Record<WallLifecycle, number>;
};

const MAX_COLUMN_CARDS = 12;

type JobRow = {
  id: string;
  item_id: string;
  title: string;
  agent_id: string | null;
  station: string | null;
  status: string;
  claimed_at: string;
  updated_at: string;
  stop_reason: string | null;
  latest_kind: string | null;
  latest_reason: string | null;
  latest_station: string | null;
  latest_actor: string | null;
  latest_evidence: string | null;
};

const wallStatusByJobStatus: Record<string, WallStatus> = {
  claimed: "waiting",
  running: "running",
  blocked: "blocked",
  fenced: "fenced",
  completed: "completed",
  failed: "failed",
  abandoned: "abandoned",
};

const lifecycleByStatus: Record<WallStatus, WallLifecycle> = {
  waiting: "todo",
  running: "active",
  blocked: "active",
  fenced: "active",
  completed: "done",
  failed: "done",
  abandoned: "done",
};

const attentionStatuses = new Set<WallStatus>(["blocked", "fenced", "failed", "abandoned"]);

function station(value: string | null): WallStation {
  if (value === "dim-station-plan" || value === "plan") return "plan";
  if (value === "dim-station-review" || value === "review") return "review";
  if (value === "ship" || value === "dim-station-ship") return "ship";
  return "build";
}

function role(value: string | null, stationName: WallStation): WallRole {
  const lower = (value ?? "").toLowerCase();
  if (lower.includes("review")) return "reviewer";
  if (lower.includes("fix")) return "fixer";
  if (lower.includes("plan")) return "planner";
  return stationName === "plan" ? "planner" : stationName === "review" ? "reviewer" : "builder";
}

function status(value: string): WallStatus {
  const mapped = wallStatusByJobStatus[value];
  if (!mapped) throw new Error(`unknown factory job status: ${value}`);
  return mapped;
}

// Every kind `factory_job_event` allows, so no raw column value reaches the wall.
const activityByKind: Record<string, string> = {
  claimed: "Claimed, not started",
  delegated: "Delegated to another agent",
  started: "Working through the item",
  commit_created: "Commit recorded",
  check_finished: "Repository check finished",
  review_finished: "Review evidence recorded",
  fenced: "Stopped at a fence",
  blocked: "Blocked on another item",
  completed: "Finished",
  failed: "Failed",
  abandoned: "Abandoned",
};

function action(row: JobRow, attention: string | undefined): string {
  // A stopped job's reason is already its attention line, and a card carrying one fact
  // twice spends its loudest row saying nothing.
  if (row.latest_reason && row.latest_reason !== attention) return row.latest_reason;
  if (!row.latest_kind) return "Awaiting first evidence";
  return activityByKind[row.latest_kind] ?? "Awaiting first evidence";
}

function mapJob(row: JobRow, now: Date): WallJob {
  const agentId = row.latest_actor ?? row.agent_id ?? "unassigned";
  const stationName = station(row.station ?? row.latest_station);
  const jobStatus = status(row.status);
  const attention = attentionStatuses.has(jobStatus)
    ? (row.stop_reason ?? row.latest_reason ?? jobStatus)
    : undefined;
  return {
    id: row.id,
    title: row.title,
    itemId: row.item_id,
    station: stationName,
    lifecycle: lifecycleByStatus[jobStatus],
    agent: agentId,
    worker: workerName(agentId),
    role: role(agentId, stationName),
    status: jobStatus,
    action: action(row, attention),
    age: age(row.updated_at || row.claimed_at, now),
    updatedAt: row.updated_at || row.claimed_at,
    evidence: row.latest_evidence ?? "No evidence recorded yet",
    ...(attention ? { attention } : {}),
  };
}

export function assembleWallSnapshot(db: Database, now = new Date()): WallSnapshot {
  const rows = db
    .query(
      `SELECT j.id, j.item_id, j.title, j.agent_id, j.station, j.status,
              j.claimed_at, j.updated_at, j.stop_reason,
              e.kind AS latest_kind, e.reason AS latest_reason, e.station AS latest_station,
              e.actor_id AS latest_actor,
              coalesce(e.reason, e.fence_type, e.commit_sha, c.subject, ch.command) AS latest_evidence
       FROM factory_job j
       LEFT JOIN factory_job_event e ON e.id = (SELECT e2.id FROM factory_job_event e2 WHERE e2.job_id = j.id ORDER BY e2.ts DESC, e2.id DESC LIMIT 1)
       LEFT JOIN factory_job_commit c ON c.job_id = j.id AND c.recorded_at = (SELECT max(recorded_at) FROM factory_job_commit WHERE job_id = j.id)
       LEFT JOIN factory_job_check ch ON ch.id = (SELECT ch2.id FROM factory_job_check ch2 WHERE ch2.job_id = j.id ORDER BY ch2.finished_at DESC, ch2.id DESC LIMIT 1)
       ORDER BY j.updated_at DESC, j.id`,
    )
    .all() as JobRow[];
  const totals: Record<WallLifecycle, number> = { todo: 0, active: 0, done: 0 };
  const jobs: WallJob[] = [];
  for (const row of rows) {
    const job = mapJob(row, now);
    totals[job.lifecycle] += 1;
    if (totals[job.lifecycle] <= MAX_COLUMN_CARDS) jobs.push(job);
  }
  return { generatedAt: now.toISOString(), source: "database", jobs, totals };
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
