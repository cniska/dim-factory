import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { writeTransaction } from "./db";
import { type OpenSession, openSessionsUnder } from "./hooks-sessions";
import { drainSpool } from "./ingest-spool";
import { checkoutAt } from "./project";
import { actingSession, ancestry, isRunning, nearestHarnessSession, workerNameOf } from "./worker";
import {
  type Acting,
  type ProcessId,
  type ProcessRow,
  refuseWorker,
  type WorkerRecord,
} from "./worker-contract";
import { processTable } from "./worker-effects";
import {
  insertSession,
  insertWorker,
  operatorSessions,
  sessionNamed,
  sessions,
  sessionsOf,
  workerNamed,
  workerNames,
} from "./worker-store";

type Above = {
  readonly table: readonly ProcessRow[];
  readonly chain: readonly ProcessId[];
  readonly open: readonly OpenSession[];
};

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

export function actingWorker(db: Database, cwd: string): Acting | null {
  const { chain, open } = above(db);
  const session = actingSession(chain, sessions(db));
  const worker = session === null ? null : workerNamed(db, session.worker);
  if (session !== null && worker !== null) return { worker, session };
  if (open.length === 0) throw refuseWorker("no_session", { cwd });
  return null;
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

export type Registered = { readonly operator: string; readonly session: string; readonly project: string };

export function registerOperator(db: Database, cwd: string): Registered {
  const project = checkoutAt(cwd)?.project;
  if (project === undefined) throw refuseWorker("no_project", { cwd });
  const { table, chain, open } = above(db);
  const inProject = open.filter(
    (session) => session.cwd !== null && checkoutAt(session.cwd)?.project === project,
  );
  const found = nearestHarnessSession(chain, inProject);
  if (found === null) throw refuseWorker("no_session", { cwd });
  return writeTransaction(db, () => {
    const registered = sessionNamed(db, found.session.id);
    if (registered !== null) return { operator: registered.worker, session: registered.id, project };
    const live = operatorSessions(db, project).find((session) => isRunning(session.process, table));
    if (live) throw refuseWorker("operator_live", { project, operator: live.worker });
    const name = mintedName(db);
    const at = new Date().toISOString();
    insertWorker(db, { role: "operator", name, project }, at);
    insertSession(
      db,
      { id: found.session.id, worker: name, harness: found.session.tool, process: found.harness },
      at,
    );
    return { operator: name, session: found.session.id, project };
  });
}
