import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { age } from "./age";
import type { JobEventKind } from "./factory-job";
import { dbPath } from "./paths";
import { openReadOnly } from "./read-db";
import wallPage from "./wall.html";
import type { ResourceEvidence, WorkerEnvironmentPhase, WorkerHookReport } from "./worker-environment";
import { workerName } from "./worker-name";

export type WallStation = "plan" | "build" | "review" | "ship" | "unknown";
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

/** Every kind a job event carries, plus the three kinds of evidence written without one,
 *  named as `dim q job` names them. */
export type WallItemKind = JobEventKind | "file_changed" | "document_updated" | "environment_reported";

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
  job: WallJob;
  runId: string;
  queueId: string;
  worktree?: string;
  branch?: string;
  entries: WallItemEntry[];
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
  run_id: string;
  queue_id: string;
  worktree: string | null;
  branch: string | null;
  latest_kind: string | null;
  latest_reason: string | null;
  latest_station: string | null;
  latest_actor: string | null;
  latest_evidence: string | null;
};

const JOB_ROW_SELECT = `SELECT j.id, j.item_id, j.title, j.agent_id, j.station, j.status,
              j.claimed_at, j.updated_at, j.stop_reason, j.run_id, j.queue_id, j.worktree, j.branch,
              e.kind AS latest_kind, e.reason AS latest_reason, e.station AS latest_station,
              e.actor_id AS latest_actor,
              coalesce(e.reason, e.fence_type, e.commit_sha, c.subject, ch.command) AS latest_evidence
       FROM factory_job j
       LEFT JOIN factory_job_event e ON e.id = (SELECT e2.id FROM factory_job_event e2 WHERE e2.job_id = j.id ORDER BY e2.ts DESC, e2.id DESC LIMIT 1)
       LEFT JOIN factory_job_commit c ON c.job_id = j.id AND c.recorded_at = (SELECT max(recorded_at) FROM factory_job_commit WHERE job_id = j.id)
       LEFT JOIN factory_job_check ch ON ch.id = (SELECT ch2.id FROM factory_job_check ch2 WHERE ch2.job_id = j.id ORDER BY ch2.finished_at DESC, ch2.id DESC LIMIT 1)`;

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

// A job is claimed with whatever word the caller passed, and a line or a typo is not a station.
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
  const rows = db.query(`${JOB_ROW_SELECT} ORDER BY j.updated_at DESC, j.id`).all() as JobRow[];
  const totals: Record<WallLifecycle, number> = { todo: 0, active: 0, done: 0 };
  const jobs: WallJob[] = [];
  for (const row of rows) {
    const job = mapJob(row, now);
    totals[job.lifecycle] += 1;
    if (totals[job.lifecycle] <= MAX_COLUMN_CARDS) jobs.push(job);
  }
  return { generatedAt: now.toISOString(), source: "database", jobs, totals };
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

/** One job's own record: the identity a card carries, and every lifecycle event and piece of
 *  evidence, ordered by the time each was recorded. Commits, checks and findings are written
 *  with the event that produced them, so they arrive attached rather than listed a second
 *  time. */
export function assembleItemView(db: Database, jobId: string, now = new Date()): WallItemView | null {
  const row = db.query(`${JOB_ROW_SELECT} WHERE j.id = ?`).get(jobId) as JobRow | null;
  if (!row) return null;
  const events = db
    .query(
      `SELECT e.ts, e.kind, e.actor_id, e.station, e.delegated_agent_id, e.delegated_station,
              e.fence_type, e.reason,
              coalesce(c.sha, e.commit_sha) AS commit_sha, c.subject AS commit_subject,
              ch.command, ch.exit_code, ch.result,
              f.dimension, f.answer, f.summary, f.resolution
       FROM factory_job_event e
       LEFT JOIN factory_job_commit c ON c.job_id = e.job_id AND c.sha = e.commit_sha
       LEFT JOIN factory_job_check ch ON ch.id = e.check_id AND ch.job_id = e.job_id
       LEFT JOIN factory_job_finding f ON f.id = e.finding_id AND f.job_id = e.job_id
       WHERE e.job_id = ? ORDER BY e.ts, e.id`,
    )
    .all(jobId) as EventRow[];
  const files = db
    .query("SELECT recorded_at, path FROM factory_job_file WHERE job_id = ? ORDER BY recorded_at, path")
    .all(jobId) as PathRow[];
  const documents = db
    .query("SELECT recorded_at, path FROM factory_job_document WHERE job_id = ? ORDER BY recorded_at, path")
    .all(jobId) as PathRow[];
  const environments = db
    .query(
      `SELECT recorded_at, phase, argv, exit_code, signal, stdout, stderr, resources
       FROM factory_job_environment WHERE job_id = ? ORDER BY recorded_at, id`,
    )
    .all(jobId) as EnvironmentRow[];
  const entries: WallItemEntry[] = [
    ...events.map(eventEntry),
    ...files.map((file) => ({ at: file.recorded_at, kind: "file_changed" as const, path: file.path })),
    ...documents.map((doc) => ({
      at: doc.recorded_at,
      kind: "document_updated" as const,
      path: doc.path,
    })),
    ...environments.map(environmentEntry),
    // Two rows recorded at the same instant carry nothing that says which was written first,
    // so they hold the order `dim q job` puts them in — events, then files, documents and
    // environment reports — rather than the two surfaces disagreeing on a tie.
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    job: mapJob(row, now),
    runId: row.run_id,
    queueId: row.queue_id,
    ...(row.worktree ? { worktree: row.worktree } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    entries,
  };
}

/** The job id a request names, or nothing where the path holds a percent sequence that is not
 *  valid UTF-8: an id the page cannot spell is an id this server holds no job for. */
function jobIdIn(pathname: string): string | null {
  const raw = pathname.slice("/api/job/".length);
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
  const item = (jobId: string): WallItemView | null => {
    const db = openReadOnly(path);
    try {
      return assembleItemView(db, jobId, new Date());
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
      if (url.pathname.startsWith("/api/job/")) {
        const jobId = jobIdIn(url.pathname);
        if (jobId === null) return new Response("Not found", { status: 404 });
        try {
          const view = item(jobId);
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
