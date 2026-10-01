import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { CodedError, refusalOf } from "./coded-error";
import { userConfigPath } from "./config";
import { writeTransaction } from "./db";
import { diffSince, tipOf } from "./git-tree";
import type { Adapter, SessionStart, Spawned } from "./harness-contract";
import type { HarnessName } from "./harness-name";
import { adapterFor, startHarness, stopOrphan } from "./harness-ops";
import { type OperatorAct, phaseAfter, ROLE_AT } from "./order";
import type { Station } from "./order-contract";
import {
  endRun,
  markHarness,
  orderState,
  type ProjectSetup,
  projectSetup,
  recordFactory,
  recordWork,
  showOrder,
  startRun,
} from "./order-ops";
import { type Env, workerHomeDir, workerSessionsDir } from "./paths";
import { shipOrder } from "./ship-ops";
import { alignBranch, branchFacts, submitSlice } from "./slice-ops";
import {
  actAllowed,
  briefAt,
  modelOf,
  policyAt,
  replyTo,
  requestOf,
  TURN_SOCKET_ENV,
  type Turn,
  type TurnEnd,
  turnEnd,
  workEntry,
  workerEnv,
} from "./station";
import { refuseStation, TurnReply, type TurnRequest } from "./station-contract";
import { closeTurn, copySession, listen, openTurn, send } from "./station-effects";
import type { Acting, Caller, Worker, WorkerSession } from "./worker-contract";
import { processOf, registerSession, stationWorker } from "./worker-ops";
import { createWorkspace, workspaceOf } from "./workspace-ops";

type TurnOf = {
  readonly order: string;
  readonly station: Station;
  readonly by: Acting;
  readonly cause: number;
  readonly model: string;
  readonly newSessionHarness: HarnessName;
  readonly checkout: string;
  readonly defaultBranch: string;
  readonly env: Env;
};

type Ended =
  | { readonly end: TurnEnd; readonly session: string }
  | { readonly end: "missed"; readonly session: string; readonly missed: string };

type SessionOf =
  | { readonly kind: "new"; readonly id: string; readonly harness: HarnessName }
  | { readonly kind: "resume"; readonly record: WorkerSession };

function sessionOf(sessions: readonly WorkerSession[], newSessionHarness: HarnessName): SessionOf {
  const current = sessions.at(-1);
  return current === undefined
    ? { kind: "new", id: crypto.randomUUID(), harness: newSessionHarness }
    : { kind: "resume", record: current };
}

const idOf = (session: SessionOf) => (session.kind === "new" ? session.id : session.record.id);

const harnessOf = (session: SessionOf) => (session.kind === "new" ? session.harness : session.record.harness);

const startOf = (session: SessionOf): SessionStart => ({ kind: session.kind, id: idOf(session) });

function openSession(
  db: Database,
  turn: TurnOf,
  worker: Worker,
  session: SessionOf,
  pid: number,
): WorkerSession {
  const process = processOf(pid);
  return writeTransaction(db, () => {
    markHarness(db, turn.order, process);
    if (session.kind === "resume") return session.record;
    const registered = { id: session.id, worker: worker.name, harness: session.harness, process };
    registerSession(db, registered);
    recordFactory(db, turn.order, turn.cause, {
      action: "session_started",
      details: { worker: worker.name, session: session.id, harness: session.harness },
    });
    return registered;
  });
}

type Served = {
  readonly db: Database;
  readonly turn: TurnOf;
  readonly workspace: string;
  readonly acting: Acting;
};

function serve({ db, turn, workspace, acting }: Served, request: TurnRequest): unknown {
  const { order, station } = turn;
  actAllowed(request, station);
  switch (request.act) {
    case "order_show":
      return showOrder(db, order);
    case "slice_submit":
      return submitSlice(db, {
        order,
        project: acting.worker.project,
        workspace,
        checkout: turn.checkout,
        acting,
        env: turn.env,
      });
    default: {
      const branch = branchFacts(workspace, order);
      recordWork(db, order, acting, station, (state) => workEntry(request, { station, state, branch }));
      return { recorded: request.act };
    }
  }
}

type TurnServed = { readonly missed: string | null; readonly fault: unknown };

async function serveTurn(
  served: Served,
  spawned: Spawned,
  socket: string,
  brief: string,
): Promise<TurnServed> {
  const { order, station } = served.turn;
  let misses: readonly string[] = [];
  let stopped = false;
  let fault: unknown = null;
  const answer = (line: string): string | null => {
    if (stopped)
      return JSON.stringify(replyTo(refuseStation("turn_stopped", { order, station }), misses).reply);
    try {
      return JSON.stringify({ ok: true, result: serve(served, requestOf(line)) });
    } catch (error) {
      if (!(error instanceof CodedError)) {
        fault = error;
        spawned.kill();
        return null;
      }
      const refused = replyTo(error, misses);
      misses = refused.misses;
      if (refused.stop) {
        stopped = true;
        spawned.kill();
      }
      return JSON.stringify(refused.reply);
    }
  };
  const listening = listen(socket, answer);
  try {
    spawned.prompt(brief);
    await spawned.ended;
  } finally {
    listening.stop();
  }
  return { missed: stopped ? misses.join("; ") : null, fault };
}

async function runTurn(db: Database, turn: TurnOf): Promise<Ended> {
  const state = orderState(db, turn.order);
  const { station } = turn;
  const { head } = state;
  invariant(head !== null, `order ${turn.order} has a recorded head once its workspace is made`);
  const { worker, sessions } = stationWorker(db, {
    role: ROLE_AT[station],
    project: state.project,
    order: turn.order,
    createdBy: turn.by.worker.name,
  });
  const session = sessionOf(sessions, turn.newSessionHarness);
  const adapter = adapterFor(harnessOf(session));
  const workspace = workspaceOf(state.project, turn.order);
  alignBranch(workspace, turn.order, head);
  const opened = openTurn(workerHomeDir(worker.name));
  try {
    const spawned = spawnFor(adapter, turn, session, workspace, opened, worker);
    const acting: Acting = { worker, session: openSession(db, turn, worker, session, spawned.pid) };
    const served = await serveTurn(
      { db, turn, workspace, acting },
      spawned,
      opened.socket,
      briefAt(station, {
        state,
        workspace,
        diff: () => diffSince(turn.checkout, turn.defaultBranch, head),
      }),
    );
    if (served.fault !== null) throw served.fault;
    const id = idOf(session);
    copySession(adapter.transcript(opened.home, workspace, id), workerSessionsDir(worker.name), id);
    return closeTurnRecord(db, turn, id, served.missed);
  } finally {
    closeTurn(opened);
  }
}

function spawnFor(
  adapter: Adapter,
  turn: TurnOf,
  session: SessionOf,
  workspace: string,
  opened: Turn,
  worker: Worker,
): Spawned {
  const argv = adapter.argv({
    session: startOf(session),
    model: turn.model,
    policy: policyAt(turn.station, { workspace, checkout: turn.checkout, turn: opened }),
    socket: opened.socket,
  });
  return startHarness(argv, workspace, workerEnv(turn.env, opened, worker.name, adapter.signIn));
}

function closeTurnRecord(db: Database, turn: TurnOf, session: string, missed: string | null): Ended {
  return writeTransaction(db, () => {
    const end = turnEnd(orderState(db, turn.order), turn.station);
    if (end !== "no_return") return { end, session };
    if (missed === null) {
      recordFactory(db, turn.order, turn.cause, {
        action: "station_failed",
        code: "no_return",
        details: { session },
      });
      return { end, session };
    }
    recordFactory(db, turn.order, turn.cause, {
      action: "station_failed",
      code: "return_missed",
      details: { session, missed },
    });
    return { end: "missed", session, missed };
  });
}

type Prepared = { readonly model: string; readonly newSessionHarness: HarnessName };

function prepareTurn(setup: ProjectSetup, project: string, station: Station): Prepared {
  const role = ROLE_AT[station];
  const model = modelOf(setup.config.models, role);
  if (model === null) throw refuseStation("no_model", { role, file: userConfigPath() });
  const newSessionHarness = setup.config.harness;
  if (newSessionHarness === undefined) throw refuseStation("harness_unset", { project });
  return { model, newSessionHarness };
}

async function turnAt(db: Database, turn: TurnOf): Promise<void> {
  const ended = await runTurn(db, turn);
  if (ended.end === "no_return") {
    throw refuseStation("no_return", { order: turn.order, station: turn.station, session: ended.session });
  }
  if (ended.end === "missed") {
    throw refuseStation("return_missed", { order: turn.order, station: turn.station, missed: ended.missed });
  }
}

export async function advanceOrder(
  db: Database,
  order: string,
  caller: Caller,
  act: OperatorAct,
  env: Env,
): Promise<void> {
  const before = orderState(db, order);
  const expected = phaseAfter(before, act);
  const setup = projectSetup(db, before.project, caller.cwd);
  const prepared = expected?.kind === "run" ? prepareTurn(setup, before.project, expected.station) : null;
  const base = tipOf(setup.root, setup.branch);
  const { by, cause, created, state, orphan } = startRun(db, order, caller, base, act);
  if (orphan !== null) stopOrphan(orphan);
  try {
    if (created) createWorkspace(setup.root, before.project, order, base);
    const { phase } = state;
    if (phase.kind === "ship") {
      await shipOrder(db, {
        order,
        project: before.project,
        checkout: setup.root,
        defaultBranch: setup.branch,
        config: setup.config,
        cause,
        env,
      });
      return;
    }
    invariant(phase.kind === "run", `order ${order} runs a station or ships after ${act.kind}`);
    invariant(prepared !== null, `order ${order} was prepared for the ${phase.station} station`);
    await turnAt(db, {
      order,
      station: phase.station,
      by,
      cause,
      checkout: setup.root,
      defaultBranch: setup.branch,
      env,
      ...prepared,
    });
  } finally {
    endRun(db, order);
  }
}

export function inTurn(env: Env): boolean {
  return env[TURN_SOCKET_ENV] !== undefined;
}

export async function sendAct(request: TurnRequest, env: Env): Promise<unknown> {
  const socket = env[TURN_SOCKET_ENV];
  if (socket === undefined) throw refuseStation("no_turn", { detail: `${TURN_SOCKET_ENV} is not set` });
  let line: string;
  try {
    line = await send(socket, JSON.stringify(request));
  } catch (error) {
    throw refuseStation("no_turn", { detail: String(error) });
  }
  const reply = TurnReply.parse(JSON.parse(line));
  if (reply.ok) return reply.result;
  throw refusalOf(reply.error);
}
