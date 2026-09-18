import type { Database } from "bun:sqlite";
import { dbPath } from "./paths";
import { openReadOnly } from "./read-db";

export type WallStation = "plan" | "build" | "review" | "ship";
export type WallStatus = "running" | "waiting" | "blocked" | "fenced" | "completed" | "failed";
export type WallRole = "builder" | "fixer" | "reviewer" | "planner";

export type WallJob = {
  id: string;
  item: string;
  station: WallStation;
  agent: string;
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
};

const MAX_ACTIVE = 12;

type JobRow = {
  id: string;
  item_id: string;
  agent_id: string | null;
  station: string | null;
  status: WallStatus;
  claimed_at: string;
  updated_at: string;
  stop_reason: string | null;
  latest_kind: string | null;
  latest_reason: string | null;
  latest_station: string | null;
  latest_actor: string | null;
  latest_evidence: string | null;
};

const stations = new Set<WallStation>(["plan", "build", "review", "ship"]);
const statuses = new Set<WallStatus>(["running", "waiting", "blocked", "fenced", "completed", "failed"]);

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

function status(value: WallStatus): WallStatus {
  if (statuses.has(value)) return value;
  return "waiting";
}

function age(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function action(row: JobRow): string {
  if (row.latest_reason) return row.latest_reason;
  if (row.latest_kind === "started") return "Working through the item";
  if (row.latest_kind === "review_finished") return "Review evidence recorded";
  return row.latest_kind ? row.latest_kind.replaceAll("_", " ") : "Awaiting first evidence";
}

function mapJob(row: JobRow, now: Date): WallJob {
  const stationName = station(row.station ?? row.latest_station);
  const jobStatus = status(row.status);
  const attention = ["blocked", "fenced", "failed"].includes(jobStatus)
    ? (row.stop_reason ?? row.latest_reason ?? jobStatus)
    : undefined;
  return {
    id: row.id,
    item: row.item_id,
    station: stationName,
    agent: row.latest_actor ?? row.agent_id ?? "unassigned",
    role: role(row.latest_actor ?? row.agent_id, stationName),
    status: jobStatus,
    action: action(row),
    age: age(row.updated_at || row.claimed_at, now),
    updatedAt: row.updated_at || row.claimed_at,
    evidence: row.latest_evidence ?? "No evidence recorded yet",
    ...(attention ? { attention } : {}),
  };
}

export function assembleWallSnapshot(db: Database, now = new Date()): WallSnapshot {
  const rows = db
    .query(
      `SELECT j.id, j.item_id, j.agent_id, j.station, j.status,
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
  const jobs = rows.map((row) => mapJob(row, now));
  const active = jobs.filter((job) => job.status !== "completed");
  return {
    generatedAt: now.toISOString(),
    source: "database",
    jobs: active.slice(0, MAX_ACTIVE),
  };
}

export async function buildWallBundle(): Promise<{ js: Uint8Array; css: Uint8Array }> {
  const result = await Bun.build({ entrypoints: ["./src/wall-client.tsx"], target: "browser", minify: true });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  const js = result.outputs.find((output) => output.path.endsWith(".js"));
  const css = result.outputs.find((output) => output.path.endsWith(".css"));
  if (!js || !css) throw new Error("wall bundle must produce JavaScript and CSS assets");
  return { js: new Uint8Array(await js.arrayBuffer()), css: new Uint8Array(await css.arrayBuffer()) };
}

const page = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/wall.css"><title>Factory wall</title></head><body><div id="root"></div><script src="/wall.js"></script></body></html>`;

export async function serveWall(
  options: { port?: number; databasePath?: string } = {},
): Promise<ReturnType<typeof Bun.serve>> {
  const bundle = await buildWallBundle();
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
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/wall.js")
        return new Response(bundle.js as unknown as BodyInit, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      if (url.pathname === "/wall.css")
        return new Response(bundle.css as unknown as BodyInit, {
          headers: { "content-type": "text/css; charset=utf-8" },
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
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
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
  setInterval(() => {
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
  return server;
}

export { stations };
