import type { Database } from "bun:sqlite";
import {
  endWorker,
  mintWorker,
  newWorkerSession,
  resolveWorker,
  sessionIdFromEnv,
  WORKER_NAME_VAR,
  WORKER_SESSION_VAR,
  WORKER_TOKEN_VAR,
  workerExports,
} from "./factory-worker";
import { readFlags } from "./flags";
import { isReadOnly, isRole, ROLES, type Role } from "./roles";
import { drainSpool } from "./spool";
import { ASSIGNMENT_TOKEN_VAR, assignWorker, bootstrapWorker } from "./worker-assignment";
import { readWorkerCredential, saveWorkerCredential } from "./worker-credential";

export class WorkerCommandError extends Error {}

/** What a person or a station may ask for here. The rest are issued by the station that
 *  spawns them and never by a caller naming a role. */
const ISSUABLE_ROLES = ROLES.filter((role) => !isReadOnly(role));

export const WORKER_USAGE = `usage: dim worker mint --role <${ISSUABLE_ROLES.join("|")}> [--pid <n>]
       dim worker run --role <${ISSUABLE_ROLES.join("|")}> -- <command> [args...]
       dim worker assign --role <${ROLES.join("|")}>
       dim worker bootstrap <assignment-id>
       dim worker end <name>

A worker is issued before it does anything, and every moment it records names it.
\`run\` issues one and starts the command carrying it, which is how a worker gets an
identity it cannot state about itself. \`mint\` prints two export lines instead, for a
shell nothing started: \`eval "$(dim worker mint --role operator)"\`.`;

const fail = (message: string): Error => new WorkerCommandError(message);

/** Required, because a hand with no role is one nothing can route and no card can draw. */
function role(given: string | undefined): Role {
  if (given === undefined)
    throw fail(`--role says what this hand is called in as; one of ${ISSUABLE_ROLES.join(", ")}`);
  if (!isRole(given)) {
    throw fail(`${given} is not a role a worker is called in as; one of ${ISSUABLE_ROLES.join(", ")}`);
  }
  // A read-only hand is spawned by the station that briefs it, which is what keeps its
  // token out of the process whose work it reads. Minting one here would hand any caller
  // the identity whose whole value is that the caller does not hold it.
  if (isReadOnly(given)) {
    throw fail(
      `a ${given} is issued by the station that spawns it, never minted: its token stays out of ` +
        "the hand whose work it reads, or the record cannot tell the two apart",
    );
  }
  return given;
}

function assignmentRole(given: string | undefined): Role {
  if (given === undefined)
    throw fail(`--role says what this hand is called in as; one of ${ROLES.join(", ")}`);
  if (!isRole(given))
    throw fail(`${given} is not a role a worker is called in as; one of ${ROLES.join(", ")}`);
  return given;
}

function pid(given: string | undefined): number | undefined {
  if (given === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(given)) throw fail(`--pid ${given} is not a process id`);
  return Number(given);
}

/**
 * The worker is issued before the process exists and its name goes into the environment
 * that process is started with, which a process cannot change about itself.
 *
 * The pid recorded is this one rather than the child's, because this waits for the child
 * and so lives exactly as long as it: a run killed before it can write `ended_at` leaves
 * a pid that stops answering, which is what keeps a dead worker's token from staying good
 * forever. The child's own pid is never observable from a call that blocks on it.
 */
function session(db: Database, env: Record<string, string | undefined>, cwd: string): string {
  const id = sessionIdFromEnv(env);
  if (id) return id;
  drainSpool(db, env);
  const active = db
    .query<{ session_id: string }, [string]>(
      `SELECT DISTINCT start.session_id
       FROM hook_event start
       WHERE start.event = 'session_start' AND start.cwd = ?
         AND NOT EXISTS (
           SELECT 1 FROM hook_event ended
           WHERE ended.session_id = start.session_id AND ended.event = 'session_end'
         )`,
    )
    .all(cwd);
  const [current] = active;
  if (current) return current.session_id;
  if (active.length > 1) {
    throw fail(`more than one active harness session is recorded for ${cwd}; carry ${WORKER_SESSION_VAR}`);
  }
  throw fail(
    `no factory session id is available in ${WORKER_SESSION_VAR}, CODEX_SESSION_ID, or CLAUDE_SESSION_ID, ` +
      `and no active SessionStart hook is recorded for ${cwd}`,
  );
}

function start(
  db: Database,
  argv: string[],
  role: Role,
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  const childSession = `${session(db, env, cwd)}/run-${newWorkerSession("child")}`;
  const parentWorker = env[WORKER_NAME_VAR] && env[WORKER_TOKEN_VAR] ? resolveWorker(db, env) : undefined;
  const minted = mintWorker(db, { role, parentWorker, pid: process.pid, sessionId: childSession });
  const [command, ...args] = argv as [string, ...string[]];
  const child = Bun.spawnSync([command, ...args], {
    env: {
      ...process.env,
      [WORKER_NAME_VAR]: minted.name,
      [WORKER_TOKEN_VAR]: minted.token,
      [WORKER_SESSION_VAR]: minted.sessionId,
    },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  endWorker(db, minted.name);
  if (!child.success) throw fail(`${minted.name} ran ${command}, which exited ${child.exitCode}`);
  return `${minted.name} ran ${command}`;
}

export function runWorkerCommand(
  db: Database,
  args: string[],
  env = process.env,
  cwd = process.cwd(),
): string {
  const [command, ...rest] = args;
  if (command === "mint") {
    const given = readFlags(rest, ["--role", "--pid"], fail);
    const workerName = env[WORKER_NAME_VAR];
    const workerToken = env[WORKER_TOKEN_VAR];
    if (workerName && workerToken) {
      const name = resolveWorker(db, env);
      const row = db
        .query<{ session_id: string; role: Role }, [string]>(
          "SELECT session_id, role FROM factory_worker WHERE name = ?",
        )
        .get(name);
      if (!row || row.session_id !== env[WORKER_SESSION_VAR]) {
        throw fail("the current worker does not match the current factory session");
      }
      if (row.role !== role(given.get("--role"))) {
        throw fail(`this factory session already carries ${row.role}, not ${given.get("--role")}`);
      }
      return workerExports({ name, token: workerToken, sessionId: row.session_id });
    }
    const workerRole = role(given.get("--role"));
    const sessionId = session(db, env, cwd);
    const existing = db
      .query<{ name: string; role: Role }, [string]>(
        "SELECT name, role FROM factory_worker WHERE session_id = ?",
      )
      .get(sessionId);
    if (existing) {
      if (existing.role !== workerRole) {
        throw fail(`this factory session already carries ${existing.role}, not ${workerRole}`);
      }
      const credential = readWorkerCredential(env, sessionId);
      if (!credential || credential.name !== existing.name) {
        throw fail(
          `worker ${existing.name} already belongs to this session, but its credential is unavailable`,
        );
      }
      resolveWorker(db, { [WORKER_NAME_VAR]: credential.name, [WORKER_TOKEN_VAR]: credential.token });
      return workerExports(credential);
    }
    const minted = mintWorker(db, {
      role: workerRole,
      pid: pid(given.get("--pid")),
      sessionId,
    });
    saveWorkerCredential(env, minted);
    return workerExports(minted);
  }
  if (command === "run") {
    const at = rest.indexOf("--");
    if (at === -1) throw fail("run takes the command to start after `--`");
    const given = readFlags(rest.slice(0, at), ["--role"], fail);
    const argv = rest.slice(at + 1);
    if (argv.length === 0) throw fail("run takes the command to start after `--`");
    return start(db, argv, role(given.get("--role")), env, cwd);
  }
  if (command === "assign") {
    const given = readFlags(rest, ["--role"], fail);
    const parentWorker = resolveWorker(db, env);
    const assignment = assignWorker(db, { parentWorker, role: assignmentRole(given.get("--role")) });
    return `export DIM_WORKER_ASSIGNMENT_ID=${assignment.id}\nexport DIM_WORKER_ASSIGNMENT_TOKEN=${assignment.token}`;
  }
  if (command === "bootstrap") {
    const [id, ...flags] = rest;
    if (!id) throw fail("bootstrap takes the assignment id");
    readFlags(flags, [], fail);
    const token = env[ASSIGNMENT_TOKEN_VAR];
    if (!token) throw fail(`${ASSIGNMENT_TOKEN_VAR} is required to bootstrap an assignment`);
    const minted = bootstrapWorker(db, {
      id,
      token,
      sessionId: session(db, env, cwd),
      pid: process.ppid,
    });
    return workerExports(minted);
  }
  if (command === "end") {
    const [name] = rest;
    if (!name) throw fail("end takes the name of the worker that stopped");
    readFlags(rest.slice(1), [], fail);
    return endWorker(db, name) ? `${name} ended` : `${name} had already ended`;
  }
  throw fail(WORKER_USAGE);
}
