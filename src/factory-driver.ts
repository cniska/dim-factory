import type { Database } from "bun:sqlite";
import {
  appendJobEvent,
  createJob,
  isTerminalJobStatus,
  type Job,
  type JobEvent,
  type JobStatus,
  jobStatus,
  recordJobCheck,
  recordJobCommit,
  recordJobDocument,
  recordJobFile,
  recordJobFinding,
  updateJobLocation,
} from "./factory-job";

export type FactoryOutcome = {
  status: Exclude<JobStatus, "claimed" | "running">;
  reason?: string;
};

export type FactoryContext = {
  item: Job;
  baseRevision: string;
  setLocation(worktree: string, branch: string): void;
  appendEvent(event: JobEvent): void;
  recordCommit(sha: string, subject?: string): void;
  recordFile(path: string): void;
  recordCheck(check: {
    command: string;
    exitCode: number;
    startedAt?: string;
    finishedAt?: string;
    result?: string;
  }): number;
  recordFinding(finding: {
    dimension: string;
    summary: string;
    answer: "fixed" | "refused";
    resolution?: string;
  }): number;
  recordDocument(path: string): void;
};

export type FactoryBuilder = (context: FactoryContext) => FactoryOutcome | Promise<FactoryOutcome>;

export async function runFactoryJob(
  db: Database,
  item: Job,
  options: { baseRevision: string },
  build: FactoryBuilder,
): Promise<FactoryOutcome> {
  createJob(db, item);
  appendJobEvent(db, item.id, { kind: "started", status: "running" });

  const context: FactoryContext = {
    item,
    baseRevision: options.baseRevision,
    setLocation: (worktree, branch) => updateJobLocation(db, item.id, worktree, branch),
    appendEvent: (event) => appendJobEvent(db, item.id, event),
    recordCommit: (sha, subject) => recordJobCommit(db, item.id, sha, subject),
    recordFile: (path) => recordJobFile(db, item.id, path),
    recordCheck: (check) => recordJobCheck(db, item.id, check),
    recordFinding: (finding) => recordJobFinding(db, item.id, finding),
    recordDocument: (path) => recordJobDocument(db, item.id, path),
  };

  try {
    const outcome = await build(context);
    appendJobEvent(db, item.id, { kind: outcome.status, status: outcome.status, reason: outcome.reason });
    return outcome;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!isTerminalJobStatus(jobStatus(db, item.id))) {
      try {
        appendJobEvent(db, item.id, { kind: "failed", status: "failed", reason });
      } catch (failureError) {
        throw new AggregateError([error, failureError], reason);
      }
    }
    throw error;
  }
}
