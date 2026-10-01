import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { invariant } from "./assert";
import { writeTransaction } from "./db";
import { HarnessName } from "./harness-name";
import { openSessionsUnder } from "./hooks-sessions";
import { drainSpool } from "./ingest-spool";
import { workerSessionsDir } from "./paths";
import { checkoutAt } from "./project";
import { actingSession, ancestry, isRunning, nearestHarnessSession, workerNameOf } from "./worker";
import {
  type Acting,
  type Caller,
  type ProcessId,
  type ProcessRow,
  refuseWorker,
  type StationRole,
  type Worker,
  type WorkerRecord,
  type WorkerSession,
} from "./worker-contract";
import { processTable, transcriptLines } from "./worker-effects";
import {
  insertSession,
  insertWorker,
  operatorOf,
  sessionNamed,
  sessions,
  sessionsOf,
  stationWorkerOf,
  workerNamed,
  workerNames,
} from "./worker-store";

type StationWorker = {
  readonly role: StationRole;
  readonly project: string;
  readonly order: string;
  readonly createdBy: string;
};

type Above = Pick<Caller, "chain" | "open"> & { readonly table: readonly ProcessRow[] };

function above(db: Database): Above {
  drainSpool(db);
  const table = processTable();
  const chain = ancestry(table, process.pid);
  const open = openSessionsUnder(
    db,
    chain.map((ancestor) => ancestor.pid),
  );
  return { table, chain, open };
}

function actingOf(db: Database, chain: readonly ProcessId[]): Acting | null {
  const session = actingSession(chain, sessions(db));
  const worker = session === null ? null : workerNamed(db, session.worker);
  return session !== null && worker !== null ? { worker, session } : null;
}

export function callerOf(db: Database, cwd: string): Caller {
  const seen = above(db);
  const [self] = seen.chain;
  invariant(self !== undefined, `the process table lists this process, ${process.pid}`);
  return {
    acting: actingOf(db, seen.chain),
    cwd,
    self,
    running: seen.table,
    chain: seen.chain,
    open: seen.open,
  };
}

export function stationWorker(db: Database, created: StationWorker): WorkerRecord {
  return writeTransaction(db, () => {
    const found = stationWorkerOf(db, created.order, created.role);
    if (found !== null) return { worker: found, sessions: sessionsOf(db, found.name) };
    const worker = { ...created, name: mintedName(db) };
    insertWorker(db, worker, new Date().toISOString());
    return { worker, sessions: [] };
  });
}

export function stationWorkerAt(db: Database, order: string, role: StationRole): Worker | null {
  return stationWorkerOf(db, order, role);
}

export function processOf(pid: number): ProcessId {
  const row = processTable().find((candidate) => candidate.pid === pid);
  invariant(row !== undefined, `process ${pid}, waiting for its prompt, is running`);
  return { pid: row.pid, startedAt: row.startedAt };
}

export function showSession(db: Database, id: string): { readonly lines: readonly unknown[] } {
  const session = sessionNamed(db, id);
  const lines =
    session === null ? null : transcriptLines(join(workerSessionsDir(session.worker), `${id}.jsonl`));
  if (lines === null) throw refuseWorker("unknown_session", { session: id });
  return { lines };
}

export function registerSession(db: Database, session: WorkerSession): void {
  insertSession(db, session, new Date().toISOString());
}

export function workersNamed(db: Database, names: readonly string[]): readonly WorkerRecord[] {
  return names.map((name) => {
    const worker = workerNamed(db, name);
    invariant(worker !== null, `worker ${name}, named in an order's log, is on record`);
    return { worker, sessions: sessionsOf(db, name) };
  });
}

function mintedName(db: Database): string {
  const taken = workerNames(db);
  for (;;) {
    const name = workerNameOf(crypto.getRandomValues(new Uint32Array(2)), taken);
    if (name !== null) return name;
  }
}

function operatorWorker(db: Database, project: string): Worker {
  const found = operatorOf(db, project);
  if (found !== null) return found;
  const worker: Worker = { role: "operator", name: mintedName(db), project };
  insertWorker(db, worker, new Date().toISOString());
  return worker;
}

export function actingOperator(db: Database, caller: Caller, project: string): Acting {
  if (caller.acting !== null) return caller.acting;
  const inProject = caller.open.filter(
    (session) => session.cwd !== null && checkoutAt(session.cwd)?.project === project,
  );
  const found = nearestHarnessSession(caller.chain, inProject);
  if (found === null) throw refuseWorker("no_session", { cwd: caller.cwd });
  return writeTransaction(db, () => {
    const worker = operatorWorker(db, project);
    const known = sessionNamed(db, found.session.id);
    if (known !== null && known.worker === worker.name) return { worker, session: known };
    const live = sessionsOf(db, worker.name).find((session) => isRunning(session.process, caller.running));
    if (live !== undefined) throw refuseWorker("not_operator", { project });
    const session = {
      id: found.session.id,
      worker: worker.name,
      harness: HarnessName.parse(found.session.tool),
      process: found.harness,
    };
    insertSession(db, session, new Date().toISOString());
    return { worker, session };
  });
}
