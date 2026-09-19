import type { Database } from "bun:sqlite";
import {
  endWorker,
  isWorkerRole,
  mintWorker,
  WORKER_ROLES,
  type WorkerRole,
  workerExports,
} from "./factory-worker";
import { readFlags } from "./flags";

export class WorkerCommandError extends Error {}

export const WORKER_USAGE = `usage: dim worker mint [--role <${WORKER_ROLES.join("|")}>] [--pid <n>]
       dim worker end <name>

A worker is issued before it does anything, and every moment it records names it.
\`mint\` prints two export lines, so a shell becomes a worker with
\`eval "$(dim worker mint)"\`.`;

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

export function runWorkerCommand(db: Database, args: string[]): string {
  const [command, ...rest] = args;
  if (command === "mint") {
    const given = readFlags(rest, ["--role", "--pid"], fail);
    return workerExports(mintWorker(db, { role: role(given.get("--role")), pid: pid(given.get("--pid")) }));
  }
  if (command === "end") {
    const [name] = rest;
    if (!name) throw fail("end takes the name of the worker that stopped");
    readFlags(rest.slice(1), [], fail);
    return endWorker(db, name) ? `${name} ended` : `${name} had already ended`;
  }
  throw fail(WORKER_USAGE);
}
