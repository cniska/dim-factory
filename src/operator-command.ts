import type { Database } from "bun:sqlite";
import { type Command, UsageError } from "./cli-contract";
import { readFlags } from "./cli-flags";
import { closeDb, openDb } from "./db";
import { labelFor } from "./git-remote";
import { drainSpool } from "./ingest-spool";
import { dbPath } from "./paths";
import { type ProcessIdentity, processAncestry, processStartedBefore } from "./pid";
import {
  type MintedWorker,
  mintWorkerForSession,
  registeredCaller,
  WORKER_NAME_VAR,
  WORKER_SESSION_VAR,
  WORKER_TOKEN_VAR,
  workerExports,
} from "./worker";
import { readWorkerCredential, saveWorkerCredential } from "./worker-credential";
import type { Role } from "./worker-roles";

const OPERATOR_ROLE = "operator" as const;

const fail = (message: string): Error => new UsageError(message);

type ActiveSession = { session_id: string; harness_pid: number | null; ts: string };

function activeSession(db: Database, env: Record<string, string | undefined>, cwd: string): ActiveSession {
  const project = labelFor(cwd);
  if (!project) throw fail(`cannot resolve this checkout's owner/repo for ${cwd}`);
  drainSpool(db, env);
  const active = db
    .query<ActiveSession & { cwd: string | null }, []>(
      `SELECT start.session_id, start.cwd, start.harness_pid, start.ts
       FROM hook_event start
       WHERE start.event = 'session_start'
         AND NOT EXISTS (
           SELECT 1 FROM factory_worker worker
           WHERE worker.session_id = start.session_id AND worker.role <> 'operator'
         )
         AND NOT EXISTS (
           SELECT 1 FROM factory_worker_session sighting
           JOIN factory_worker worker ON worker.name = sighting.worker
           WHERE sighting.session_id = start.session_id AND worker.role <> 'operator'
         )
         AND NOT EXISTS (
           SELECT 1 FROM hook_event ended
           WHERE ended.session_id = start.session_id AND ended.event = 'session_end'
         ) ORDER BY start.ts`,
    )
    .all();
  const sessions = new Map<string, ActiveSession>();
  for (const session of active) {
    if (session.cwd && labelFor(session.cwd) === project && !sessions.has(session.session_id)) {
      sessions.set(session.session_id, session);
    }
  }
  if (sessions.size > 1) {
    throw fail(`more than one active operator session is recorded for ${project}; the factory cannot choose`);
  }
  const [current] = sessions.values();
  if (current) return current;
  throw fail(`no active harness session is recorded for project ${project}`);
}

function workerForSession(
  db: Database,
  workerRole: Role,
  sessionId: string,
  env: Record<string, string | undefined>,
  harness: ProcessIdentity,
): MintedWorker {
  const workerName = env[WORKER_NAME_VAR];
  const workerToken = env[WORKER_TOKEN_VAR];
  if (Boolean(workerName) !== Boolean(workerToken)) {
    throw fail(`both ${WORKER_NAME_VAR} and ${WORKER_TOKEN_VAR} must be present together`);
  }
  const credential =
    workerName && workerToken
      ? { name: workerName, token: workerToken, sessionId: env[WORKER_SESSION_VAR] ?? "" }
      : readWorkerCredential(env, sessionId);
  const minted = mintWorkerForSession(db, {
    role: workerRole,
    sessionId,
    pid: harness.pid,
    processStartedAt: harness.startedAt,
    credential,
  });
  saveWorkerCredential(env, minted);
  return minted;
}

export function runOperatorCommand(
  db: Database,
  args: string[] = [],
  env = process.env,
  cwd = process.cwd(),
  ancestry: readonly ProcessIdentity[] = processAncestry(),
): string {
  readFlags(args, [], fail);
  if (registeredCaller(db, ancestry))
    throw fail("this process already belongs to a factory worker or runner");
  const session = activeSession(db, env, cwd);
  const harness = ancestry.find((entry) => entry.pid === session.harness_pid);
  if (!harness) throw fail("the active session's harness is not an ancestor of this process");
  if (!processStartedBefore(harness.startedAt, session.ts)) {
    throw fail("the active session's harness started after its SessionStart event");
  }
  return workerExports(workerForSession(db, OPERATOR_ROLE, session.session_id, env, harness));
}

export const operatorCommand: Command = {
  name: "operator",
  usage: "usage: dim operator",
  summary: "print this project's operator credentials as shell exports, for eval",
  raw: () => true,
  run(args) {
    const db = openDb(dbPath());
    try {
      console.log(runOperatorCommand(db, args, process.env, process.cwd()));
    } finally {
      closeDb(db);
    }
  },
};
