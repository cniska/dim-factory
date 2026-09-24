import type { Database } from "bun:sqlite";
import {
  type MintedWorker,
  mintWorkerForSession,
  WORKER_NAME_VAR,
  WORKER_SESSION_VAR,
  WORKER_TOKEN_VAR,
  workerExports,
} from "./factory-worker";
import { readFlags } from "./flags";
import { labelFor } from "./git-remote";
import type { Role } from "./roles";
import { drainSpool } from "./spool";
import { readWorkerCredential, saveWorkerCredential } from "./worker-credential";

export class OperatorCommandError extends Error {}

const OPERATOR_ROLE = "operator" as const;

export const OPERATOR_USAGE = `usage: dim operator

Print this project's operator credentials for the current shell.`;

const fail = (message: string): Error => new OperatorCommandError(message);

function activeSession(db: Database, env: Record<string, string | undefined>, cwd: string): string {
  const project = labelFor(cwd);
  if (!project) throw fail(`cannot resolve this checkout's owner/repo for ${cwd}`);
  drainSpool(db, env);
  const active = db
    .query<{ session_id: string; cwd: string | null }, []>(
      `SELECT DISTINCT start.session_id, start.cwd
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
         )`,
    )
    .all();
  const sessions = new Set(
    active
      .filter((session) => session.cwd && labelFor(session.cwd) === project)
      .map((session) => session.session_id),
  );
  if (sessions.size > 1) {
    throw fail(`more than one active operator session is recorded for ${project}; the factory cannot choose`);
  }
  const [current] = sessions;
  if (current) return current;
  throw fail(`no active harness session is recorded for project ${project}`);
}

function workerForSession(
  db: Database,
  workerRole: Role,
  sessionId: string,
  env: Record<string, string | undefined>,
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
): string {
  readFlags(args, [], fail);
  const sessionId = activeSession(db, env, cwd);
  return workerExports(workerForSession(db, OPERATOR_ROLE, sessionId, env));
}
