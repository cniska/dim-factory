import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { invariant, unreachable } from "./assert";
import { CodedError, refusalOf } from "./coded-error";
import { userConfigPath } from "./config";
import { writeTransaction } from "./db";
import { diffSince, gitCommonDir, type Identity, tipOf } from "./git-tree";
import { claude } from "./harness-claude";
import type { Outcome, SessionStart, Spawned } from "./harness-contract";
import { startHarness, stopOrphan } from "./harness-ops";
import { type Death, type OperatorAct, type OrderState, phaseAfter, ROLE_AT, type WorkBy } from "./order";
import { type DeathCode, type Later, refuseOrder, type Station } from "./order-contract";
import {
  endRun,
  markHarness,
  orderState,
  ownerIdentity,
  type ProjectSetup,
  projectSetup,
  recordAs,
  recordWork,
  showOrder,
  startRun,
} from "./order-ops";
import { type Env, workerHomeDir, workerSessionsDir } from "./paths";
import { shipOrder } from "./ship-ops";
import { alignBranch, branchFacts, submitSlice } from "./slice-ops";
import {
  messagePurpose,
  modelOf,
  type Purpose,
  policyOf,
  replyTo,
  requestOf,
  stationPurpose,
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
import { processOf, registerSession, stationWorker, stationWorkerAt } from "./worker-ops";
import { createWorkspace, workspaceOf } from "./workspace-ops";

type TurnOf = {
  readonly order: string;
  readonly station: Station;
  readonly by: Acting;
  readonly cause: number;
  readonly model: string;
  readonly identity: Identity;
  readonly checkout: string;
  readonly checkoutGit: string;
  readonly defaultBranch: string;
  readonly env: Env;
  readonly purpose: Purpose;
};

type Ended =
  | { readonly end: TurnEnd; readonly session: string }
  | { readonly end: "missed"; readonly session: string; readonly missed: string }
  | { readonly end: "died"; readonly session: string; readonly code: DeathCode }
  | { readonly end: "lost"; readonly session: string }
  | { readonly end: "config_changed"; readonly session: string };

type Replied =
  | { readonly end: "replied"; readonly reply: string }
  | { readonly end: "no_reply"; readonly session: string }
  | { readonly end: "died"; readonly session: string; readonly code: DeathCode }
  | { readonly end: "lost"; readonly session: string }
  | { readonly end: "config_changed"; readonly session: string };

type SessionOf =
  | { readonly kind: "new"; readonly id: string }
  | { readonly kind: "fork"; readonly id: string; readonly from: string }
  | { readonly kind: "resume"; readonly record: WorkerSession };

function sessionOf(sessions: readonly WorkerSession[], died: readonly Death[]): SessionOf {
  const current = sessions.at(-1);
  const fresh = { kind: "new", id: crypto.randomUUID() } as const;
  if (current === undefined) return fresh;
  const death = died.find((one) => one.session === current.id);
  if (death === undefined) return { kind: "resume", record: current };
  return death.copied ? { kind: "fork", id: crypto.randomUUID(), from: current.id } : fresh;
}

const idOf = (session: SessionOf) => (session.kind === "resume" ? session.record.id : session.id);

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

const byFactory = (turn: TurnOf): WorkBy => ({ kind: "factory", cause: turn.cause });

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
    const registered = { id: session.id, worker: worker.name, harness: "claude", process } as const;
    registerSession(db, registered);
    recordAs(db, turn.order, byFactory(turn), {
      action: "session_started",
      details: { worker: worker.name, session: session.id, harness: registered.harness },
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
  const refusal = turn.purpose.refusal(request.act);
  if (refusal !== null) throw refusal;
  switch (request.act) {
    case "order_show":
      return showOrder(db, order);
    case "slice_submit":
      return submitSlice(db, { order, workspace, acting, env: turn.env });
    case "message_send": {
      const { text, to } = request;
      if (to !== null) {
        recordWork(db, order, acting, station, () => ({ action: "message_refused", details: { to, text } }));
        throw refuseStation("not_to_operator", { to });
      }
      const operator = turn.by.worker.name;
      recordWork(db, order, acting, station, () => ({
        action: "message_sent",
        details: { to: operator, text },
      }));
      return { sent: operator };
    }
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
  prompt: string,
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
    spawned.prompt(prompt);
    const ended = await spawned.ended;
    const { cause } = stopped;
    const changed = served.config.putBack() && cause?.kind !== "fault";
    return { stop: changed ? { kind: "config_changed" } : cause, ended };
  } finally {
    listening.stop();
  }
}

type Closing = {
  readonly acting: Acting;
  readonly session: string;
  readonly stop: Exclude<Stop, { readonly kind: "fault" }> | null;
  readonly outcome: Outcome;
  readonly copied: boolean;
  readonly resumed: boolean;
};

async function runTurn(db: Database, turn: TurnOf): Promise<Closing> {
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
  const session = sessionOf(sessions, state.died);
  const workspace = workspaceOf(state.project, turn.order).dir;
  alignBranch(workspace, turn.order, head);
  const opened = openTurn(workerHomeDir(worker.name));
  try {
    if (session.kind === "fork") {
      restoreSession(copies, session.from, claude.transcript(opened.home, workspace, session.from));
    }
    const spawned = spawnFor(turn, session, workspace, opened);
    const acting: Acting = { worker, session: openSession(db, turn, worker, session, spawned.pid) };
    const served = await serveTurn(
      { db, turn, workspace, acting, config: guardFile(join(turn.checkoutGit, "config")) },
      spawned,
      opened.socket,
      turn.purpose.prompt({ state, workspace, diff: diffOf(turn, head) }),
    );
    const { stop } = served;
    if (stop?.kind === "fault") throw stop.error;
    const id = idOf(session);
    const outcome = claude.outcome(served.ended, startOf(session));
    const transcript = claude.transcript(opened.home, workspace, id);
    if (outcome.kind === "finished" || sessionWritten(transcript)) copySession(transcript, copies, id);
    return {
      acting,
      session: id,
      stop,
      outcome,
      copied: sessionHeld(copies, id),
      resumed: session.kind === "resume",
    };
  } finally {
    closeTurn(opened);
  }
}

function diffOf(turn: TurnOf, head: string): string | null {
  return turn.station === "review" ? diffSince(turn.checkout, turn.defaultBranch, head) : null;
}

function spawnFor(turn: TurnOf, session: SessionOf, workspace: string, opened: Turn): Spawned {
  const argv = claude.argv({
    session: startOf(session),
    model: turn.model,
    policy: policyOf(turn.purpose.policy, { workspace, checkoutGit: turn.checkoutGit, turn: opened }),
    socket: opened.socket,
  });
  return startHarness(argv, workspace, workerEnv(turn.env, opened, turn.identity, claude));
}

function deathOf(session: string, copied: boolean, outcome: Outcome & { readonly kind: "died" }): Later {
  return outcome.code === "usage_limit"
    ? { action: "session_died", code: outcome.code, details: { session, copied, resetsAt: outcome.resetsAt } }
    : { action: "session_died", code: outcome.code, details: { session, copied } };
}

function closeStationTurn(db: Database, turn: TurnOf, closing: Closing): Ended {
  const { session, stop } = closing;
  const failed = (later: Later) => recordAs(db, turn.order, byFactory(turn), later);
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
  const failed = (later: Later) => recordAs(db, turn.order, byFactory(turn), later);
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

function closeMessageTurn(
  db: Database,
  turn: TurnOf,
  { acting, session, stop, outcome, copied, resumed }: Closing,
): Replied {
  if (stop?.kind === "config_changed") return { end: "config_changed", session };
  invariant(stop === null, `a message turn on order ${turn.order} has no definition of done to miss`);
  if (outcome.kind === "died") {
    if (outcome.code === "resume_failed" && resumed) return { end: "lost", session };
    recordAs(db, turn.order, byFactory(turn), deathOf(session, copied, outcome));
    return { end: "died", session, code: outcome.code };
  }
  if (outcome.result === null) return { end: "no_reply", session };
  recordAs(
    db,
    turn.order,
    { kind: "worker", acting },
    { action: "message_sent", details: { to: turn.by.worker.name, text: outcome.result } },
  );
  return { end: "replied", reply: outcome.result };
}

type Prepared = {
  readonly model: string;
  readonly identity: Identity;
};

function prepareTurn(setup: ProjectSetup, station: Station, env: Env): Prepared {
  const role = ROLE_AT[station];
  const model = modelOf(setup.config.models, role);
  if (model === null) throw refuseStation("no_model", { role, file: userConfigPath() });
  return { model, identity: ownerIdentity(setup.root, env) };
}

async function turnAt(db: Database, turn: TurnOf): Promise<void> {
  const first = closeStationTurn(db, turn, await runTurn(db, turn));
  const ended = first.end === "lost" ? closeStationTurn(db, turn, await runTurn(db, turn)) : first;
  const { order, station } = turn;
  invariant(ended.end !== "lost", `order ${order}'s replacement session is a fork, never a resume`);
  switch (ended.end) {
    case "returned":
    case "closed":
      return;
    case "config_changed":
      throw refuseStation("git_config_changed", { order, station, config: join(turn.checkoutGit, "config") });
    case "died":
      throw refuseStation("session_died", { order, station, session: ended.session, code: ended.code });
    case "no_return":
      throw refuseStation("no_return", { order, station, session: ended.session });
    case "missed":
      throw refuseStation("return_missed", { order, station, missed: ended.missed });
    default:
      return unreachable(ended);
  }
}

async function messageAt(db: Database, turn: TurnOf): Promise<string> {
  const first = closeMessageTurn(db, turn, await runTurn(db, turn));
  const ended = first.end === "lost" ? closeMessageTurn(db, turn, await runTurn(db, turn)) : first;
  const { order, station } = turn;
  invariant(ended.end !== "lost", `order ${order}'s replacement session is a fork, never a resume`);
  switch (ended.end) {
    case "replied":
      return ended.reply;
    case "config_changed":
      throw refuseStation("git_config_changed", { order, station, config: join(turn.checkoutGit, "config") });
    case "died":
      throw refuseStation("session_died", { order, station, session: ended.session, code: ended.code });
    case "no_reply":
      throw refuseStation("no_reply", { order, station, session: ended.session });
    default:
      return unreachable(ended);
  }
}

type Running = {
  readonly setup: ProjectSetup;
  readonly cause: number;
  readonly state: OrderState;
  turnOf(station: Station, purpose: Purpose): TurnOf;
};

async function withRun<T>(
  db: Database,
  order: string,
  caller: Caller,
  act: OperatorAct,
  station: Station | null,
  env: Env,
  body: (running: Running) => Promise<T>,
): Promise<T> {
  const { project } = orderState(db, order);
  const setup = projectSetup(db, project, caller.cwd);
  const prepared = station === null ? null : prepareTurn(setup, station, env);
  const base = tipOf(setup.root, setup.branch);
  const { by, cause, created, state, orphan } = startRun(db, order, caller, base, act);
  try {
    if (orphan !== null) stopOrphan(orphan);
    if (created) createWorkspace(setup.root, project, order, base);
    return await body({
      setup,
      cause,
      state,
      turnOf: (at, purpose) => {
        invariant(prepared !== null && at === station, `order ${order} was prepared for the ${at} station`);
        return {
          order,
          station: at,
          by,
          cause,
          checkout: setup.root,
          checkoutGit: gitCommonDir(setup.root),
          defaultBranch: setup.branch,
          env,
          purpose,
          ...prepared,
        };
      },
    });
  } finally {
    endRun(db, order);
  }
}

export async function advanceOrder(
  db: Database,
  order: string,
  caller: Caller,
  act: OperatorAct,
  env: Env,
): Promise<void> {
  const expected = phaseAfter(orderState(db, order), act);
  const station = expected?.kind === "run" ? expected.station : null;
  await withRun(db, order, caller, act, station, env, async ({ setup, cause, state, turnOf }) => {
    const { phase } = state;
    if (phase.kind === "ship") {
      await shipOrder(db, {
        order,
        project: state.project,
        checkout: setup.root,
        defaultBranch: setup.branch,
        config: setup.config,
        cause,
        env,
      });
      return;
    }
    invariant(phase.kind === "run", `order ${order} runs a station or ships after ${act.kind}`);
    await turnAt(db, turnOf(phase.station, stationPurpose(phase.station)));
  });
}

export async function messageWorker(
  db: Database,
  order: string,
  caller: Caller,
  { station, text }: { readonly station: Station; readonly text: string },
  env: Env,
): Promise<string> {
  const worker = stationWorkerAt(db, order, ROLE_AT[station]);
  if (worker === null) throw refuseOrder("no_worker", { order, station });
  const act = { kind: "message", to: worker.name, text } as const;
  return withRun(db, order, caller, act, station, env, ({ turnOf }) =>
    messageAt(db, turnOf(station, messagePurpose(text))),
  );
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
