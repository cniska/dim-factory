import type { Database } from "bun:sqlite";

export type LaneStatus = "claimed" | "running" | "completed" | "blocked" | "fenced" | "failed" | "abandoned";
export type LaneEventKind =
  | "claimed"
  | "delegated"
  | "started"
  | "commit_created"
  | "check_finished"
  | "review_finished"
  | "fenced"
  | "blocked"
  | "completed"
  | "failed"
  | "abandoned";

export type Lane = {
  id: string;
  runId: string;
  queueId: string;
  itemId: string;
  agentId?: string;
  sessionId?: string;
  worktree?: string;
  branch?: string;
  station?: string;
};

export type LaneEvent = {
  kind: LaneEventKind;
  actorId?: string;
  sessionId?: string;
  station?: string;
  delegatedAgentId?: string;
  delegatedSessionId?: string;
  delegatedStation?: string;
  commitSha?: string;
  checkId?: number;
  findingId?: number;
  fenceType?: string;
  status?: LaneStatus;
  reason?: string;
  ts?: string;
};

const now = (): string => new Date().toISOString();
const terminalStatuses = new Set<LaneStatus>(["completed", "blocked", "fenced", "failed", "abandoned"]);

function eventValues(laneId: string, event: LaneEvent, ts: string): (string | number | null)[] {
  return [
    laneId,
    ts,
    event.kind,
    event.actorId ?? null,
    event.sessionId ?? null,
    event.station ?? null,
    event.delegatedAgentId ?? null,
    event.delegatedSessionId ?? null,
    event.delegatedStation ?? null,
    event.commitSha ?? null,
    event.checkId ?? null,
    event.findingId ?? null,
    event.fenceType ?? null,
    event.status ?? null,
    event.reason ?? null,
  ];
}

export function createLane(db: Database, lane: Lane, at = now()): void {
  db.transaction(() => {
    db.run(
      `INSERT INTO factory_lane
       (id, run_id, queue_id, item_id, agent_id, session_id, worktree, branch, station, status, claimed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`,
      [
        lane.id,
        lane.runId,
        lane.queueId,
        lane.itemId,
        lane.agentId ?? null,
        lane.sessionId ?? null,
        lane.worktree ?? null,
        lane.branch ?? null,
        lane.station ?? null,
        at,
        at,
      ],
    );
    appendLaneEvent(
      db,
      lane.id,
      { kind: "claimed", actorId: lane.agentId, sessionId: lane.sessionId, station: lane.station },
      at,
    );
  })();
}

export function appendLaneEvent(db: Database, laneId: string, event: LaneEvent, at = now()): void {
  db.transaction(() => {
    const lane = db.query("SELECT status FROM factory_lane WHERE id = ?").get(laneId) as {
      status: LaneStatus;
    } | null;
    if (!lane) throw new Error(`lane not found: ${laneId}`);
    if (terminalStatuses.has(lane.status)) {
      throw new Error(`lane ${laneId} is already ${lane.status}`);
    }

    db.run(
      `INSERT INTO factory_lane_event
       (lane_id, ts, kind, actor_id, session_id, station, delegated_agent_id, delegated_session_id,
        delegated_station, commit_sha, check_id, finding_id, fence_type, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventValues(laneId, event, event.ts ?? at),
    );
    db.run(
      `UPDATE factory_lane SET status = coalesce(?, status), updated_at = ?, started_at = coalesce(started_at, ?),
       completed_at = CASE WHEN ? IN ('completed', 'blocked', 'fenced', 'failed', 'abandoned') THEN ? ELSE completed_at END,
       stop_reason = coalesce(?, stop_reason)
       WHERE id = ?`,
      [
        event.status ?? null,
        event.ts ?? at,
        event.kind === "started" ? (event.ts ?? at) : null,
        event.status ?? null,
        event.ts ?? at,
        event.reason ?? null,
        laneId,
      ],
    );
  })();
}

export function recordLaneCommit(
  db: Database,
  laneId: string,
  sha: string,
  subject?: string,
  at = now(),
): void {
  db.run("INSERT INTO factory_lane_commit (lane_id, sha, subject, recorded_at) VALUES (?, ?, ?, ?)", [
    laneId,
    sha,
    subject ?? null,
    at,
  ]);
  appendLaneEvent(db, laneId, { kind: "commit_created", commitSha: sha }, at);
}

export function recordLaneFile(db: Database, laneId: string, path: string, at = now()): void {
  db.run("INSERT INTO factory_lane_file (lane_id, path, recorded_at) VALUES (?, ?, ?)", [laneId, path, at]);
}

export function recordLaneCheck(
  db: Database,
  laneId: string,
  check: { command: string; exitCode: number; startedAt?: string; finishedAt?: string; result?: string },
  at = now(),
): number {
  const result = db.run(
    `INSERT INTO factory_lane_check (lane_id, command, exit_code, started_at, finished_at, result, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      laneId,
      check.command,
      check.exitCode,
      check.startedAt ?? null,
      check.finishedAt ?? at,
      check.result ?? null,
      at,
    ],
  );
  const id = Number(result.lastInsertRowid);
  appendLaneEvent(db, laneId, { kind: "check_finished", checkId: id }, at);
  return id;
}

export function recordLaneFinding(
  db: Database,
  laneId: string,
  finding: { dimension: string; summary: string; answer: "fixed" | "refused"; resolution?: string },
  at = now(),
): number {
  const result = db.run(
    `INSERT INTO factory_lane_finding (lane_id, dimension, summary, answer, resolution, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [laneId, finding.dimension, finding.summary, finding.answer, finding.resolution ?? null, at],
  );
  const id = Number(result.lastInsertRowid);
  appendLaneEvent(db, laneId, { kind: "review_finished", findingId: id }, at);
  return id;
}

export function recordLaneDocument(db: Database, laneId: string, path: string, at = now()): void {
  db.run("INSERT INTO factory_lane_document (lane_id, path, recorded_at) VALUES (?, ?, ?)", [
    laneId,
    path,
    at,
  ]);
}
