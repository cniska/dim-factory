import type { Database } from "bun:sqlite";
import {
  appendJobEvent,
  createJob,
  isTerminalJobStatus,
  type JobEventKind,
  type JobStatus,
  moveJob,
  recordJobCheck,
  recordJobCommit,
  recordJobDocument,
  recordJobFile,
  recordJobFinding,
  TERMINAL_JOB_STATUSES,
} from "./factory-job";

export class JobCommandError extends Error {}

export const JOB_USAGE = `usage: dim job claim <job-id> --run <id> --queue <id> --item <id> --title "..."
                      [--description "..."] [--agent <id>] [--session <id>] [--station <name>]
                      [--worktree <path>] [--branch <name>]
       dim job start <job-id>
       dim job move <job-id> --station <name>
       dim job commit <job-id> --sha <sha> [--subject "..."]
       dim job file <job-id> --path <path>
       dim job check <job-id> --command "..." --exit <code> [--result "..."]
       dim job finding <job-id> --dimension <name> --summary "..." --answer <fixed|refused>
                       [--resolution "..."]
       dim job document <job-id> --path <path>
       dim job stop <job-id> <${TERMINAL_JOB_STATUSES.join("|")}> [--reason "..."]`;

const CLAIM_FLAGS = [
  "--run",
  "--queue",
  "--item",
  "--title",
  "--description",
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
    description: given.get("--description"),
    agentId: given.get("--agent"),
    sessionId: given.get("--session"),
    worktree: given.get("--worktree"),
    branch: given.get("--branch"),
    station: given.get("--station"),
  });
  return `claimed ${jobId} for ${itemId} on ${queueId}`;
}

/**
 * Read as digits rather than through `Number`, which turns "" and " " into 0 and
 * "1e3" into 1000: a check that never ran would be recorded as one that passed.
 */
function exitCode(given: Map<string, string>): number {
  const spec = required(given, "--exit");
  if (!/^-?\d+$/.test(spec)) throw new JobCommandError(`--exit ${spec} is not an exit code`);
  return Number(spec);
}

function answer(given: Map<string, string>): "fixed" | "refused" {
  const value = required(given, "--answer");
  if (value !== "fixed" && value !== "refused") {
    throw new JobCommandError(`${value} is not an answer a finding can end on`);
  }
  return value;
}

/**
 * Each of these records one row and returns what it wrote, because the caller is a
 * skill reading its own shell output back rather than a caller holding a value.
 */
type Evidence = {
  flags: string[];
  record: (db: Database, id: string, given: Map<string, string>) => string;
};

const EVIDENCE: Record<string, Evidence> = {
  commit: {
    flags: ["--sha", "--subject"],
    record: (db, id, given) => {
      const sha = required(given, "--sha");
      recordJobCommit(db, id, sha, given.get("--subject"));
      return `${id} recorded commit ${sha}`;
    },
  },
  file: {
    flags: ["--path"],
    record: (db, id, given) => {
      const path = required(given, "--path");
      recordJobFile(db, id, path);
      return `${id} recorded ${path}`;
    },
  },
  check: {
    flags: ["--command", "--exit", "--result"],
    record: (db, id, given) => {
      const command = required(given, "--command");
      const code = exitCode(given);
      recordJobCheck(db, id, { command, exitCode: code, result: given.get("--result") });
      return `${id} recorded ${command} (${code})`;
    },
  },
  finding: {
    flags: ["--dimension", "--summary", "--answer", "--resolution"],
    record: (db, id, given) => {
      const dimension = required(given, "--dimension");
      const ended = answer(given);
      recordJobFinding(db, id, {
        dimension,
        summary: required(given, "--summary"),
        answer: ended,
        resolution: given.get("--resolution"),
      });
      return `${id} recorded a ${ended} finding on ${dimension}`;
    },
  },
  document: {
    flags: ["--path"],
    record: (db, id, given) => {
      const path = required(given, "--path");
      recordJobDocument(db, id, path);
      return `${id} recorded ${path}`;
    },
  },
};

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
  if (command === "move") {
    const station = required(flags(rest, ["--station"]), "--station");
    moveJob(db, jobId, station);
    return `${jobId} moved to ${station}`;
  }
  // Own property only: an object literal inherits `toString` and `constructor`, and
  // `dim job toString` would reach one instead of the refusal every other name gets.
  if (Object.hasOwn(EVIDENCE, command)) {
    const evidence = EVIDENCE[command] as Evidence;
    return evidence.record(db, jobId, flags(rest, evidence.flags));
  }
  if (command === "stop") return stop(db, jobId, rest);
  throw new JobCommandError(`${command} is not a job subcommand`);
}
