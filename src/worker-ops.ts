import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { openSessionsUnder } from "./hooks-sessions";
import { drainSpool } from "./ingest-spool";
import { checkoutAt } from "./project";
import { actingSession, ancestry, isRunning, nearestHarnessSession, workerNameOf } from "./worker";
import { type Acting, refuseWorker, type WorkerRecord } from "./worker-contract";
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

export function actingWorker(db: Database, cwd: string): Acting | null {
  drainSpool(db);
  const chain = ancestry(processTable(), process.pid);
  const session = actingSession(chain, sessions(db));
  const worker = session === null ? null : workerNamed(db, session.worker);
  if (session !== null && worker !== null) return { worker, session };
  if (
    openSessionsUnder(
      db,
      chain.map((ancestor) => ancestor.pid),
    ).length === 0
  ) {
    throw refuseWorker("no_session", { cwd });
  }
  return null;
}

export function workersNamed(db: Database, names: readonly string[]): readonly WorkerRecord[] {
  return names.flatMap((name) => {
    const worker = workerNamed(db, name);
    return worker === null ? [] : [{ worker, sessions: sessionsOf(db, name) }];
  });
}

function mintedName(db: Database): string {
  const taken = workerNames(db);
  for (;;) {
    const name = workerNameOf(crypto.getRandomValues(new Uint32Array(2)), taken);
    if (name !== null) return name;
  }
}

export function registerOperator(
  db: Database,
  cwd: string,
): { readonly operator: string; readonly session: string; readonly project: string } {
  const project = checkoutAt(cwd)?.project;
  if (project === undefined) throw refuseWorker("no_project", { cwd });
  drainSpool(db);
  const table = processTable();
  const chain = ancestry(table, process.pid);
  const open = openSessionsUnder(
    db,
    chain.map((ancestor) => ancestor.pid),
  ).filter((session) => session.cwd !== null && checkoutAt(session.cwd)?.project === project);
  const found = nearestHarnessSession(chain, open);
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
