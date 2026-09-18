import type { Database } from "bun:sqlite";
import {
  appendJobEvent,
  createJob,
  isTerminalJobStatus,
  type JobEventKind,
  type JobStatus,
  TERMINAL_JOB_STATUSES,
} from "./factory-job";

export class JobCommandError extends Error {}

export const JOB_USAGE = `usage: dim job claim <job-id> --run <id> --queue <id> --item <id> --title "..."
                      [--statement "..."] [--agent <id>] [--session <id>] [--station <name>]
                      [--worktree <path>] [--branch <name>]
       dim job start <job-id>
       dim job stop <job-id> <${TERMINAL_JOB_STATUSES.join("|")}> [--reason "..."]`;

const CLAIM_FLAGS = [
  "--run",
  "--queue",
  "--item",
  "--title",
  "--statement",
  "--agent",
  "--session",
  "--station",
  "--worktree",
  "--branch",
];

/**
 * A flag given twice is refused rather than resolved to either value: a skill
 * assembles these from a shell line, and a title that silently lost half of
 * itself reads on the wall as a job nobody can match back to its item.
 */
function flags(args: string[], allowed: string[]): Map<string, string> {
  const given = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] as string;
    const value = args[index + 1];
    if (!allowed.includes(flag)) throw new JobCommandError(`${flag} is not an option this takes`);
    if (value === undefined) throw new JobCommandError(`${flag} needs a value`);
    // A value that reads as a flag is refused rather than taken, so a missing
    // argument cannot quietly consume the next option as its own text.
    if (value.startsWith("--")) throw new JobCommandError(`${flag} needs a value that is not an option`);
    if (given.has(flag)) throw new JobCommandError(`${flag} may be given once`);
    given.set(flag, value);
  }
  return given;
}

function required(given: Map<string, string>, flag: string): string {
  const value = given.get(flag);
  if (value === undefined) throw new JobCommandError(`${flag} is required`);
  return value;
}

function claim(db: Database, jobId: string, args: string[]): string {
  const given = flags(args, CLAIM_FLAGS);
  const itemId = required(given, "--item");
  const queueId = required(given, "--queue");
  createJob(db, {
    id: jobId,
    runId: required(given, "--run"),
    queueId,
    itemId,
    title: required(given, "--title"),
    statement: given.get("--statement"),
    agentId: given.get("--agent"),
    sessionId: given.get("--session"),
    worktree: given.get("--worktree"),
    branch: given.get("--branch"),
    station: given.get("--station"),
  });
  return `claimed ${jobId} for ${itemId} on ${queueId}`;
}

function stop(db: Database, jobId: string, args: string[]): string {
  const [status, ...rest] = args;
  if (!status) throw new JobCommandError("stop needs the status the job stopped at");
  const terminal = status as JobStatus;
  if (!isTerminalJobStatus(terminal)) {
    throw new JobCommandError(`${status} is not a status a job can stop at`);
  }
  const given = flags(rest, ["--reason"]);
  appendJobEvent(db, jobId, {
    kind: terminal as JobEventKind,
    status: terminal,
    reason: given.get("--reason"),
  });
  return `${jobId} stopped as ${terminal}`;
}

export function runJobCommand(db: Database, args: string[]): string {
  const [command, jobId, ...rest] = args;
  if (!command || !jobId) throw new JobCommandError("job takes a subcommand and a job id");
  if (command === "claim") return claim(db, jobId, rest);
  if (command === "start") {
    flags(rest, []);
    appendJobEvent(db, jobId, { kind: "started", status: "running" });
    return `${jobId} is running`;
  }
  if (command === "stop") return stop(db, jobId, rest);
  throw new JobCommandError(`${command} is not a job subcommand`);
}
