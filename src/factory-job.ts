import type { Database } from "bun:sqlite";

export type JobStatus = "claimed" | "running" | "completed" | "blocked" | "fenced" | "failed" | "abandoned";
export type JobEventKind =
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

export type Job = {
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

export type JobEvent = {
  kind: JobEventKind;
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
  status?: JobStatus;
  reason?: string;
  ts?: string;
};

const now = (): string => new Date().toISOString();
const terminalStatuses = new Set<JobStatus>(["completed", "blocked", "fenced", "failed", "abandoned"]);

export function isTerminalJobStatus(status: JobStatus): boolean {
  return terminalStatuses.has(status);
}

function eventValues(jobId: string, event: JobEvent, ts: string): (string | number | null)[] {
  return [
    jobId,
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

export function createJob(db: Database, job: Job, at = now()): void {
  db.transaction(() => {
    db.run(
      `INSERT INTO factory_job
       (id, run_id, queue_id, item_id, agent_id, session_id, worktree, branch, station, status, claimed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`,
      [
        job.id,
        job.runId,
        job.queueId,
        job.itemId,
        job.agentId ?? null,
        job.sessionId ?? null,
        job.worktree ?? null,
        job.branch ?? null,
        job.station ?? null,
        at,
        at,
      ],
    );
    appendJobEvent(
      db,
      job.id,
      { kind: "claimed", actorId: job.agentId, sessionId: job.sessionId, station: job.station },
      at,
    );
  })();
}

export function updateJobLocation(db: Database, jobId: string, worktree: string, branch: string): void {
  const result = db.run("UPDATE factory_job SET worktree = ?, branch = ?, updated_at = ? WHERE id = ?", [
    worktree,
    branch,
    now(),
    jobId,
  ]);
  if (result.changes !== 1) throw new Error(`job not found: ${jobId}`);
}

export function jobStatus(db: Database, jobId: string): JobStatus {
  const job = db.query("SELECT status FROM factory_job WHERE id = ?").get(jobId) as {
    status: JobStatus;
  } | null;
  if (!job) throw new Error(`job not found: ${jobId}`);
  return job.status;
}

export function appendJobEvent(db: Database, jobId: string, event: JobEvent, at = now()): void {
  db.transaction(() => {
    if (isTerminalJobStatus(event.kind as JobStatus) && event.status !== event.kind) {
      throw new Error(`terminal event kind must match its status: ${event.kind}`);
    }
    if (event.status && isTerminalJobStatus(event.status) && event.kind !== event.status) {
      throw new Error(`terminal event status must match its kind: ${event.status}`);
    }
    const job = db.query("SELECT status FROM factory_job WHERE id = ?").get(jobId) as {
      status: JobStatus;
    } | null;
    if (!job) throw new Error(`job not found: ${jobId}`);
    if (isTerminalJobStatus(job.status)) {
      throw new Error(`job ${jobId} is already ${job.status}`);
    }

    db.run(
      `INSERT INTO factory_job_event
       (job_id, ts, kind, actor_id, session_id, station, delegated_agent_id, delegated_session_id,
        delegated_station, commit_sha, check_id, finding_id, fence_type, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventValues(jobId, event, event.ts ?? at),
    );
    db.run(
      `UPDATE factory_job SET status = coalesce(?, status), updated_at = ?, started_at = coalesce(started_at, ?),
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
        jobId,
      ],
    );
  })();
}

export function recordJobCommit(
  db: Database,
  jobId: string,
  sha: string,
  subject?: string,
  at = now(),
): void {
  db.run("INSERT INTO factory_job_commit (job_id, sha, subject, recorded_at) VALUES (?, ?, ?, ?)", [
    jobId,
    sha,
    subject ?? null,
    at,
  ]);
  appendJobEvent(db, jobId, { kind: "commit_created", commitSha: sha }, at);
}

export function recordJobFile(db: Database, jobId: string, path: string, at = now()): void {
  db.run("INSERT INTO factory_job_file (job_id, path, recorded_at) VALUES (?, ?, ?)", [jobId, path, at]);
}

export function recordJobCheck(
  db: Database,
  jobId: string,
  check: { command: string; exitCode: number; startedAt?: string; finishedAt?: string; result?: string },
  at = now(),
): number {
  const result = db.run(
    `INSERT INTO factory_job_check (job_id, command, exit_code, started_at, finished_at, result, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId,
      check.command,
      check.exitCode,
      check.startedAt ?? null,
      check.finishedAt ?? at,
      check.result ?? null,
      at,
    ],
  );
  const id = Number(result.lastInsertRowid);
  appendJobEvent(db, jobId, { kind: "check_finished", checkId: id }, at);
  return id;
}

export function recordJobFinding(
  db: Database,
  jobId: string,
  finding: { dimension: string; summary: string; answer: "fixed" | "refused"; resolution?: string },
  at = now(),
): number {
  const result = db.run(
    `INSERT INTO factory_job_finding (job_id, dimension, summary, answer, resolution, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [jobId, finding.dimension, finding.summary, finding.answer, finding.resolution ?? null, at],
  );
  const id = Number(result.lastInsertRowid);
  appendJobEvent(db, jobId, { kind: "review_finished", findingId: id }, at);
  return id;
}

export function recordJobDocument(db: Database, jobId: string, path: string, at = now()): void {
  db.run("INSERT INTO factory_job_document (job_id, path, recorded_at) VALUES (?, ?, ?)", [jobId, path, at]);
}
