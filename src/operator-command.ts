import type { Database } from "bun:sqlite";
import { type Command, UsageError } from "./cli-contract";
import { readFlags } from "./cli-flags";
import { closeDb, openDb } from "./db";
import { labelFor } from "./git-remote";
import { drainSpool } from "./ingest-spool";
import { dbPath } from "./paths";
import { type ProcessIdentity, processAncestry, processStartedBefore } from "./pid";
import { mintWorkerForSession, registeredCaller } from "./worker";
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

function roleOf(db: Database, worker: string): Role | undefined {
  return db.query<{ role: Role }, [string]>("SELECT role FROM factory_worker WHERE name = ?").get(worker)
    ?.role;
}

export function runOperatorCommand(
  db: Database,
  args: string[] = [],
  env = process.env,
  cwd = process.cwd(),
  ancestry: readonly ProcessIdentity[] = processAncestry(),
): string {
  readFlags(args, [], fail);
  const registered = registeredCaller(db, ancestry);
  if (registered?.kind === "worker" && roleOf(db, registered.worker.name) === OPERATOR_ROLE) {
    return registered.worker.name;
  }
  if (registered) throw fail("this process already belongs to a factory worker or runner");
  const session = activeSession(db, env, cwd);
  const harness = ancestry.find((entry) => entry.pid === session.harness_pid);
  if (!harness) throw fail("the active session's harness is not an ancestor of this process");
  if (!processStartedBefore(harness.startedAt, session.ts)) {
    throw fail("the active session's harness started after its SessionStart event");
  }
  return mintWorkerForSession(db, {
    role: OPERATOR_ROLE,
    sessionId: session.session_id,
    pid: harness.pid,
    processStartedAt: harness.startedAt,
  }).name;
}

export const operatorCommand: Command = {
  name: "operator",
  usage: "usage: dim operator",
  summary: "register this session's harness as the project's operator and print its name",
  run(args) {
    const db = openDb(dbPath());
    try {
      return runOperatorCommand(db, args, process.env, process.cwd());
    } finally {
      closeDb(db);
    }
  },
};
