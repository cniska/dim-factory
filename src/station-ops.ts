import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { CodedError, recordOf, refusalOf } from "./coded-error";
import { userConfigPath } from "./config";
import { writeTransaction } from "./db";
import type { HarnessName } from "./harness-name";
import { adapterFor, startHarness } from "./harness-ops";
import { type LeadingAct, phaseAfter, ROLE_AT } from "./order";
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
import { alignBranch, branchFacts, submitSlice } from "./slice-ops";
import {
  briefAt,
  modelOf,
  policyAt,
  requestOf,
  sliceSubmitAllowed,
  TURN_SOCKET_ENV,
  type TurnEnd,
  turnEnd,
  workEntry,
  workerEnv,
} from "./station";
import {
  refuseStation,
  type TurnReply,
  TurnReply as TurnReplySchema,
  type TurnRequest,
} from "./station-contract";
import { closeTurn, copySession, listen, openTurn, send } from "./station-effects";
import type { Acting, Caller, WorkerSession } from "./worker-contract";
import { processOf, registerSession, stationWorker } from "./worker-ops";
import { baseOf, createWorkspace, workspaceOf } from "./workspace-ops";

type TurnOf = {
  readonly order: string;
  readonly station: Station;
  readonly by: Acting;
  readonly cause: number;
  readonly model: string;
  readonly newSessionHarness: HarnessName;
  readonly checkout: string;
};

const MISSES_TO_FAIL = 2;

type Ended =
  | { readonly end: TurnEnd; readonly session: string }
  | { readonly end: "missed"; readonly session: string; readonly missed: string };

function serve(db: Database, turn: TurnOf, workspace: string, acting: Acting, request: TurnRequest): unknown {
  const { order, station } = turn;
  switch (request.act) {
    case "order_show":
      return showOrder(db, order);
    case "slice_submit":
      sliceSubmitAllowed(station);
      return submitSlice(db, {
        order,
        project: acting.worker.project,
        workspace,
        checkout: turn.checkout,
        acting,
      });
    default: {
      const branch = branchFacts(workspace, order);
      recordWork(db, order, acting, station, (state) => workEntry(request, { station, state, branch }));
      return { recorded: request.act };
    }
  }
}

function replyTo(error: unknown): TurnReply {
  if (error instanceof CodedError) return { ok: false, error: recordOf(error) };
  throw error;
}

async function runTurn(db: Database, turn: TurnOf): Promise<Ended> {
  const state = orderState(db, turn.order);
  const { worker, sessions } = stationWorker(db, {
    role: ROLE_AT[turn.station],
    project: state.project,
    order: turn.order,
    createdBy: turn.by.worker.name,
  });
  const current = sessions.at(-1);
  const session =
    current === undefined
      ? { kind: "new" as const, id: crypto.randomUUID() }
      : { kind: "resume" as const, id: current.id };
  const harness = current?.harness ?? turn.newSessionHarness;
  const adapter = adapterFor(harness);
  const workspace = workspaceOf(state.project, turn.order);
  const { station } = turn;
  invariant(station !== "review", "the review station's brief is not built");
  invariant(state.head !== null, `order ${turn.order} has a recorded head once its workspace is made`);
  alignBranch(workspace, turn.order, state.head);
  const opened = openTurn(workerHomeDir(worker.name));
  try {
    const argv = adapter.argv({
      session,
      model: turn.model,
      policy: policyAt(station, { workspace, checkout: turn.checkout, turn: opened }),
      socket: opened.socket,
    });
    const env = workerEnv(process.env, opened, worker.name, adapter.signIn);
    const spawned = startHarness(argv, workspace, env);
    const harnessProcess = processOf(spawned.pid);
    const registered: WorkerSession = current ?? {
      id: session.id,
      worker: worker.name,
      harness,
      process: harnessProcess,
    };
    writeTransaction(db, () => {
      markHarness(db, turn.order, harnessProcess);
      if (current !== undefined) return;
      registerSession(db, registered);
      recordFactory(db, turn.order, turn.cause, {
        action: "session_started",
        details: { worker: worker.name, session: session.id, harness },
      });
    });
    const acting: Acting = { worker, session: registered };
    const misses: string[] = [];
    const faults: unknown[] = [];
    const stopped = () => misses.length >= MISSES_TO_FAIL;
    const answer = (line: string): unknown => {
      if (stopped()) throw refuseStation("turn_stopped", { order: turn.order, station: turn.station });
      try {
        return serve(db, turn, workspace, acting, requestOf(line));
      } catch (error) {
        if (error instanceof CodedError && error.code === "not_done") {
          misses.push(error.message);
          if (stopped()) spawned.kill();
        }
        throw error;
      }
    };
    const listening = listen(opened.socket, async (line) => {
      try {
        return JSON.stringify({ ok: true, result: answer(line) });
      } catch (error) {
        try {
          return JSON.stringify(replyTo(error));
        } catch (fault) {
          faults.push(fault);
          spawned.kill();
          throw fault;
        }
      }
    });
    try {
      spawned.prompt(briefAt(station, state, workspace));
      await spawned.ended;
    } finally {
      listening.stop();
    }
    const [fault] = faults;
    if (fault !== undefined) throw fault;
    copySession(
      adapter.transcript(opened.home, workspace, session.id),
      workerSessionsDir(worker.name),
      session.id,
    );
    return closeTurnRecord(db, turn, session.id, stopped() ? misses.join("; ") : null);
  } finally {
    closeTurn(opened);
  }
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
  leading: LeadingAct,
): Promise<void> {
  const before = orderState(db, order);
  const expected = phaseAfter(before, leading);
  const setup = projectSetup(db, before.project, caller.cwd);
  const prepared = expected.kind === "run" ? prepareTurn(setup, before.project, expected.station) : null;
  const base = baseOf(setup.root, setup.branch);
  const { by, cause, created, state } = startRun(db, order, caller, base, leading);
  try {
    if (created) createWorkspace(setup.root, before.project, order, base);
    const { phase } = state;
    invariant(
      phase.kind === "run",
      `order ${order} runs a station after ${leading.kind}; shipping is not built`,
    );
    invariant(prepared !== null, `order ${order} was prepared for the ${phase.station} station`);
    await turnAt(db, { order, station: phase.station, by, cause, checkout: setup.root, ...prepared });
  } finally {
    endRun(db, order);
  }
}

export async function sendAct(request: TurnRequest, env: Env = process.env): Promise<unknown> {
  const socket = env[TURN_SOCKET_ENV];
  if (socket === undefined) throw refuseStation("no_turn", { detail: `${TURN_SOCKET_ENV} is not set` });
  let line: string;
  try {
    line = await send(socket, JSON.stringify(request));
  } catch (error) {
    throw refuseStation("no_turn", { detail: String(error) });
  }
  const reply = TurnReplySchema.parse(JSON.parse(line));
  if (reply.ok) return reply.result;
  throw refusalOf(reply.error);
}
