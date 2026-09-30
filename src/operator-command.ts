import type { Database } from "bun:sqlite";
import { type Command, UsageError } from "./cli-contract";
import { closeDb, writeTransaction } from "./db";
import { openFactory } from "./factory-db";
import { openSessionsUnder } from "./hooks-sessions";
import { drainSpool } from "./ingest-spool";
import { checkoutAt } from "./project";
import { ancestry, isRunning, nearestHarnessSession, workerNameOf } from "./worker";
import { refuse } from "./worker-contract";
import { processTable } from "./worker-effects";
import { insertSession, insertWorker, operatorSessions, sessions, workerNames } from "./worker-store";

const USAGE = "usage: dim operator register";

const projectAt = (dir: string) => checkoutAt(dir)?.project ?? null;

function mintedName(db: Database): string {
  const taken = workerNames(db);
  for (;;) {
    const name = workerNameOf(crypto.getRandomValues(new Uint32Array(2)), taken);
    if (name !== null) return name;
  }
}

function register(cwd: string) {
  const project = projectAt(cwd);
  if (project === null) throw refuse("no_project", { cwd });
  const db = openFactory();
  try {
    drainSpool(db);
    const table = processTable();
    const chain = ancestry(table, process.pid);
    const open = openSessionsUnder(
      db,
      chain.map((ancestor) => ancestor.pid),
    ).filter((session) => session.cwd !== null && projectAt(session.cwd) === project);
    const found = nearestHarnessSession(chain, open);
    if (found === null) throw refuse("no_session", { cwd });
    return writeTransaction(db, () => {
      const registered = sessions(db).find((session) => session.id === found.session.id);
      if (registered) return { operator: registered.worker, session: registered.id, project };
      const live = operatorSessions(db, project).find((session) => isRunning(session.process, table));
      if (live) throw refuse("operator_live", { project, operator: live.worker });
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
  } finally {
    closeDb(db);
  }
}

export const operatorCommand: Command = {
  name: "operator",
  usage: USAGE,
  summary: "register the harness session this runs in as its project's operator",
  run(args) {
    if (args[0] !== "register" || args.length > 1) throw new UsageError(USAGE);
    return register(process.cwd());
  },
};
