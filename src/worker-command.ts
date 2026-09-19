import type { Database } from "bun:sqlite";
import {
  endWorker,
  isWorkerRole,
  mintWorker,
  WORKER_NAME_VAR,
  WORKER_ROLES,
  WORKER_TOKEN_VAR,
  type WorkerRole,
  workerExports,
} from "./factory-worker";
import { readFlags } from "./flags";

export class WorkerCommandError extends Error {}

export const WORKER_USAGE = `usage: dim worker mint [--role <${WORKER_ROLES.join("|")}>] [--pid <n>]
       dim worker run [--role <${WORKER_ROLES.join("|")}>] -- <command> [args...]
       dim worker end <name>

A worker is issued before it does anything, and every moment it records names it.
\`run\` issues one and starts the command carrying it, which is how a worker gets an
identity it cannot state about itself. \`mint\` prints two export lines instead, for a
shell nothing started: \`eval "$(dim worker mint)"\`.`;

const fail = (message: string): Error => new WorkerCommandError(message);

function role(given: string | undefined): WorkerRole | undefined {
  if (given === undefined) return undefined;
  if (!isWorkerRole(given)) {
    throw fail(`${given} is not a role a worker is called in as; one of ${WORKER_ROLES.join(", ")}`);
  }
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
function start(db: Database, argv: string[], role: WorkerRole | undefined): string {
  const minted = mintWorker(db, { pid: process.pid, ...(role === undefined ? {} : { role }) });
  const [command, ...args] = argv as [string, ...string[]];
  const child = Bun.spawnSync([command, ...args], {
    env: {
      ...process.env,
      [WORKER_NAME_VAR]: minted.name,
      [WORKER_TOKEN_VAR]: minted.token,
    },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  endWorker(db, minted.name);
  if (!child.success) throw fail(`${minted.name} ran ${command}, which exited ${child.exitCode}`);
  return `${minted.name} ran ${command}`;
}

export function runWorkerCommand(db: Database, args: string[]): string {
  const [command, ...rest] = args;
  if (command === "mint") {
    const given = readFlags(rest, ["--role", "--pid"], fail);
    return workerExports(mintWorker(db, { role: role(given.get("--role")), pid: pid(given.get("--pid")) }));
  }
  if (command === "run") {
    const at = rest.indexOf("--");
    if (at === -1) throw fail("run takes the command to start after `--`");
    const given = readFlags(rest.slice(0, at), ["--role"], fail);
    const argv = rest.slice(at + 1);
    if (argv.length === 0) throw fail("run takes the command to start after `--`");
    return start(db, argv, role(given.get("--role")));
  }
  if (command === "end") {
    const [name] = rest;
    if (!name) throw fail("end takes the name of the worker that stopped");
    readFlags(rest.slice(1), [], fail);
    return endWorker(db, name) ? `${name} ended` : `${name} had already ended`;
  }
  throw fail(WORKER_USAGE);
}
