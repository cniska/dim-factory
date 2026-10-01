import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { invariant, unreachable } from "./assert";
import { CodedError, refusalOf } from "./coded-error";
import { userConfigPath } from "./config";
import { writeTransaction } from "./db";
import { diffSince, gitCommonDir, type Identity, tipOf } from "./git-tree";
import type { Adapter, Outcome, SessionStart, Spawned } from "./harness-contract";
import type { HarnessName } from "./harness-name";
import { adapterFor, startHarness, stopOrphan } from "./harness-ops";
import { type Death, type OperatorAct, phaseAfter, ROLE_AT } from "./order";
import type { DeathCode, Later, Station } from "./order-contract";
import {
  endRun,
  markHarness,
  orderState,
  ownerIdentity,
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
import {
  closeTurn,
  copySession,
  type FileGuard,
  guardFile,
  listen,
  openTurn,
  restoreSession,
  send,
  sessionHeld,
  sessionWritten,
} from "./station-effects";
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
  readonly identity: Identity;
  readonly checkout: string;
  readonly checkoutGit: string;
  readonly defaultBranch: string;
  readonly env: Env;
};

type Ended =
  | { readonly end: TurnEnd; readonly session: string }
  | { readonly end: "missed"; readonly session: string; readonly missed: string }
  | { readonly end: "died"; readonly session: string; readonly code: DeathCode }
  | { readonly end: "lost"; readonly session: string }
  | { readonly end: "config_changed"; readonly session: string };

type SessionOf =
  | { readonly kind: "new"; readonly id: string; readonly harness: HarnessName }
  | { readonly kind: "fork"; readonly id: string; readonly harness: HarnessName; readonly from: string }
  | { readonly kind: "resume"; readonly record: WorkerSession };

function sessionOf(
  sessions: readonly WorkerSession[],
  died: readonly Death[],
  newSessionHarness: HarnessName,
): SessionOf {
  const current = sessions.at(-1);
  const fresh = { kind: "new", id: crypto.randomUUID(), harness: newSessionHarness } as const;
  if (current === undefined) return fresh;
  const death = died.find((one) => one.session === current.id);
  if (death === undefined) return { kind: "resume", record: current };
  return death.copied
    ? { kind: "fork", id: crypto.randomUUID(), harness: current.harness, from: current.id }
    : fresh;
}

const idOf = (session: SessionOf) => (session.kind === "resume" ? session.record.id : session.id);

const harnessOf = (session: SessionOf) =>
  session.kind === "resume" ? session.record.harness : session.harness;

function startOf(session: SessionOf): SessionStart {
  switch (session.kind) {
    case "new":
      return { kind: "new", id: session.id };
    case "fork":
      return { kind: "fork", id: session.id, from: session.from };
    case "resume":
      return { kind: "resume", id: session.record.id };
  }
}

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
  readonly config: FileGuard;
};

function serve({ db, turn, workspace, acting }: Served, request: TurnRequest): unknown {
  const { order, station } = turn;
  actAllowed(request, station);
  switch (request.act) {
    case "order_show":
      return showOrder(db, order);
    case "slice_submit":
      return submitSlice(db, { order, workspace, acting, env: turn.env });
    default: {
      const branch = branchFacts(workspace, order);
      recordWork(db, order, acting, station, (state) => workEntry(request, { station, state, branch }));
      return { recorded: request.act };
    }
  }
}

type TurnServed = {
  readonly stop: Stop | null;
  readonly ended: Awaited<Spawned["ended"]>;
};

type Stop =
  | { readonly kind: "missed"; readonly missed: string }
  | { readonly kind: "config_changed" }
  | { readonly kind: "fault"; readonly error: unknown };

async function serveTurn(
  served: Served,
  spawned: Spawned,
  socket: string,
  brief: string,
): Promise<TurnServed> {
  const { order, station } = served.turn;
  let misses: readonly string[] = [];
  const stopped: { cause: Stop | null } = { cause: null };
  const stopWith = (cause: Stop) => {
    stopped.cause = cause;
    spawned.kill();
  };
  const answer = (line: string): string | null => {
    if (stopped.cause !== null)
      return JSON.stringify(replyTo(refuseStation("turn_stopped", { order, station }), misses).reply);
    if (served.config.putBack()) {
      stopWith({ kind: "config_changed" });
      const changed = refuseStation("git_config_changed", { order, station, config: served.config.path });
      return JSON.stringify(replyTo(changed, misses).reply);
    }
    try {
      return JSON.stringify({ ok: true, result: serve(served, requestOf(line)) });
    } catch (error) {
      if (!(error instanceof CodedError)) {
        stopWith({ kind: "fault", error });
        return null;
      }
      const refused = replyTo(error, misses);
      misses = refused.misses;
      if (refused.stop) stopWith({ kind: "missed", missed: misses.join("; ") });
      return JSON.stringify(refused.reply);
    }
  };
  const listening = listen(socket, answer);
  try {
    spawned.prompt(brief);
    const ended = await spawned.ended;
    const { cause } = stopped;
    const changed = served.config.putBack() && cause?.kind !== "fault";
    return { stop: changed ? { kind: "config_changed" } : cause, ended };
  } finally {
    listening.stop();
  }
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
  const copies = workerSessionsDir(worker.name);
  const session = sessionOf(sessions, state.died, turn.newSessionHarness);
  const adapter = adapterFor(harnessOf(session));
  const workspace = workspaceOf(state.project, turn.order).dir;
  alignBranch(workspace, turn.order, head);
  const opened = openTurn(workerHomeDir(worker.name));
  try {
    if (session.kind === "fork") {
      restoreSession(copies, session.from, adapter.transcript(opened.home, workspace, session.from));
    }
    const spawned = spawnFor(adapter, turn, session, workspace, opened);
    const acting: Acting = { worker, session: openSession(db, turn, worker, session, spawned.pid) };
    const served = await serveTurn(
      { db, turn, workspace, acting, config: guardFile(join(turn.checkoutGit, "config")) },
      spawned,
      opened.socket,
      briefAt(station, {
        state,
        workspace,
        diff: station === "review" ? diffSince(turn.checkout, turn.defaultBranch, head) : null,
      }),
    );
    const { stop } = served;
    if (stop?.kind === "fault") throw stop.error;
    const id = idOf(session);
    const outcome = adapter.outcome(served.ended, startOf(session));
    const transcript = adapter.transcript(opened.home, workspace, id);
    if (outcome.kind === "finished" || sessionWritten(transcript)) copySession(transcript, copies, id);
    return closeTurnRecord(db, turn, {
      session: id,
      stop,
      outcome,
      copied: sessionHeld(copies, id),
      resumed: session.kind === "resume",
    });
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
): Spawned {
  const argv = adapter.argv({
    session: startOf(session),
    model: turn.model,
    policy: policyAt(turn.station, { workspace, checkoutGit: turn.checkoutGit, turn: opened }),
    socket: opened.socket,
  });
  return startHarness(argv, workspace, workerEnv(turn.env, opened, turn.identity, adapter));
}

type Closing = {
  readonly session: string;
  readonly stop: Exclude<Stop, { readonly kind: "fault" }> | null;
  readonly outcome: Outcome;
  readonly copied: boolean;
  readonly resumed: boolean;
};

function deathOf(session: string, copied: boolean, outcome: Outcome & { readonly kind: "died" }): Later {
  return outcome.code === "usage_limit"
    ? { action: "session_died", code: outcome.code, details: { session, copied, resetsAt: outcome.resetsAt } }
    : { action: "session_died", code: outcome.code, details: { session, copied } };
}

function closeTurnRecord(db: Database, turn: TurnOf, closing: Closing): Ended {
  const { session, stop } = closing;
  const failed = (later: Later) => recordFactory(db, turn.order, turn.cause, later);
  return writeTransaction(db, () => {
    switch (stop?.kind) {
      case "config_changed":
        failed({ action: "station_failed", code: "git_config_changed", details: { session } });
        return { end: "config_changed", session };
      case "missed":
        failed({
          action: "station_failed",
          code: "return_missed",
          details: { session, missed: stop.missed },
        });
        return { end: "missed", session, missed: stop.missed };
      case undefined:
        return closeEndedTurn(db, turn, closing);
      default:
        return unreachable(stop);
    }
  });
}

function closeEndedTurn(db: Database, turn: TurnOf, { session, outcome, copied, resumed }: Closing): Ended {
  const failed = (later: Later) => recordFactory(db, turn.order, turn.cause, later);
  if (outcome.kind === "died") failed(deathOf(session, copied, outcome));
  const end = turnEnd(orderState(db, turn.order), turn.station);
  if (end !== "no_return") return { end, session };
  if (outcome.kind === "died" && outcome.code === "resume_failed" && resumed) return { end: "lost", session };
  if (outcome.kind === "died") {
    failed({ action: "station_failed", code: "session_died", details: { session } });
    return { end: "died", session, code: outcome.code };
  }
  failed({ action: "station_failed", code: "no_return", details: { session } });
  return { end, session };
}

type Prepared = {
  readonly model: string;
  readonly newSessionHarness: HarnessName;
  readonly identity: Identity;
};

function prepareTurn(setup: ProjectSetup, project: string, station: Station, env: Env): Prepared {
  const role = ROLE_AT[station];
  const model = modelOf(setup.config.models, role);
  if (model === null) throw refuseStation("no_model", { role, file: userConfigPath() });
  const newSessionHarness = setup.config.harness;
  if (newSessionHarness === undefined) throw refuseStation("harness_unset", { project });
  const identity = ownerIdentity(setup.root, env);
  return { model, newSessionHarness, identity };
}

async function turnAt(db: Database, turn: TurnOf): Promise<void> {
  const first = await runTurn(db, turn);
  const ended = first.end === "lost" ? await runTurn(db, turn) : first;
  invariant(ended.end !== "lost", `order ${turn.order}'s replacement session is a fork, never a resume`);
  if (ended.end === "config_changed") {
    throw refuseStation("git_config_changed", {
      order: turn.order,
      station: turn.station,
      config: join(turn.checkoutGit, "config"),
    });
  }
  if (ended.end === "died") {
    throw refuseStation("session_died", {
      order: turn.order,
      station: turn.station,
      session: ended.session,
      code: ended.code,
    });
  }
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
  const prepared =
    expected?.kind === "run" ? prepareTurn(setup, before.project, expected.station, env) : null;
  const base = tipOf(setup.root, setup.branch);
  const { by, cause, created, state, orphan } = startRun(db, order, caller, base, act);
  try {
    if (orphan !== null) stopOrphan(orphan);
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
      checkoutGit: gitCommonDir(setup.root),
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
