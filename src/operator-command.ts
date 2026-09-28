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

type OwnSession = { sessionId: string; harness: ProcessIdentity };

function ownSession(
  db: Database,
  env: Record<string, string | undefined>,
  cwd: string,
  ancestry: readonly ProcessIdentity[],
): OwnSession {
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
         ) ORDER BY start.ts DESC`,
    )
    .all();
  const latest = new Map<string, ActiveSession>();
  for (const session of active) {
    if (session.cwd && labelFor(session.cwd) === project && !latest.has(session.session_id)) {
      latest.set(session.session_id, session);
    }
  }
  if (latest.size === 0) throw fail(`no active harness session is recorded for project ${project}`);
  const own = [...latest.values()].flatMap((session) => {
    const harness = ancestry.find((entry) => entry.pid === session.harness_pid);
    return harness && processStartedBefore(harness.startedAt, session.ts)
      ? [{ sessionId: session.session_id, harness }]
      : [];
  });
  if (own.length > 1) {
    throw fail(
      `more than one active session in ${project} runs above this process; the factory cannot choose`,
    );
  }
  const [current] = own;
  if (current) return current;
  throw fail(`no active session in ${project} has its harness above this process`);
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
  const { sessionId, harness } = ownSession(db, env, cwd, ancestry);
  return mintWorkerForSession(db, {
    role: OPERATOR_ROLE,
    sessionId,
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
