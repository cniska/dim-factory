import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { invariant, unreachable } from "./assert";
import { install } from "./check-ops";
import { isRefusal, refusalOf } from "./coded-error";
import { userConfigPath } from "./config";
import { writeTransaction } from "./db";
import { checkTask, installCommand } from "./declared-tasks";
import { diffSince, gitCommonDir, type Identity, tipOf } from "./git";
import type { SessionStart, Spawned } from "./harness-contract";
import { startHarness, stopHarness, WORKER_HARNESS } from "./harness-ops";
import { type Death, type OrderState, phaseAfter, roleAt, stepRefusal, type WorkBy } from "./order";
import { type OperatorAct, refuseOrder, type Station } from "./order-contract";
import {
  endRun,
  markHarness,
  orderState,
  ownerIdentity,
  type ProjectSetup,
  projectCheckout,
  projectSetup,
  recordAs,
  recordAt,
  recordCancel,
  recordStop,
  showOrder,
  startRun,
} from "./order-ops";
import { type Env, workerHomeDir, workerSessionsDir } from "./paths";
import { shipOrder } from "./ship-ops";
import { settleSubmission, submitSlice } from "./slice-ops";
import {
  closedTurn,
  type Ended,
  messagePurpose,
  modelOf,
  type Purpose,
  policyOf,
  replyTo,
  requestOf,
  stationPurpose,
  TURN_SOCKET_ENV,
  type Turn,
  type TurnClose,
  type TurnStop,
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
import { stationInstructions } from "./station-instructions";
import { pinnedEnv } from "./toolchain-ops";
import type { Trace } from "./trace-contract";
import { traceOf } from "./trace-ops";
import { followUsage } from "./usage-follow";
import type { Acting, Caller, Worker, WorkerSession } from "./worker-contract";
import { processOf, registerSession, stationWorker, stationWorkerAt } from "./worker-ops";
import type { Workspace } from "./workspace";
import { alignBranch, branchFacts, createWorkspace, removeWorkspace, workspaceOf } from "./workspace-ops";

type TurnOf = {
  readonly trace: Trace;
  readonly order: string;
  readonly station: Station;
  readonly by: Acting;
  readonly cause: number;
  readonly model: string;
  readonly identity: Identity;
  readonly checkout: string;
  readonly checkoutGit: string;
  readonly gitConfig: string;
  readonly defaultBranch: string;
  readonly env: Env;
  readonly purpose: Purpose;
};

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
    const registered = { id: session.id, worker: worker.name, harness: WORKER_HARNESS.name, process };
    registerSession(db, registered);
    recordAs(turn.trace, db, turn.order, byFactory(turn), {
      action: "session_started",
      details: { worker: worker.name, session: session.id, harness: registered.harness },
    });
    return registered;
  });
}

type Served = {
  readonly db: Database;
  readonly turn: TurnOf;
  readonly workspace: Workspace;
  readonly acting: Acting;
  readonly config: FileGuard;
};

function serve({ db, turn, workspace, acting }: Served, request: TurnRequest): unknown {
  const { trace, order, station } = turn;
  const refusal = turn.purpose.refusal(request.act);
  if (refusal !== null) throw refusal;
  switch (request.act) {
    case "order_show":
      return showOrder(db, order);
    case "slice_submit":
      return submitSlice(db, { trace, order, workspace, acting, env: turn.env });
    case "message_send": {
      const { text, to } = request;
      const by = { kind: "worker", acting } as const;
      if (to !== null) {
        recordStop({
          record: (later) => recordAt(trace, db, { order, station, by, later: () => later }),
          order,
          stop: { action: "message_refused", code: "not_to_operator", details: { to, text } },
          refuse: refuseStation,
        });
      }
      const operator = turn.by.worker.name;
      recordAt(trace, db, {
        order,
        station,
        by,
        later: () => ({ action: "message_sent", details: { to: operator, text } }),
      });
      return { sent: operator };
    }
    default: {
      const branch = branchFacts(workspace);
      recordAt(trace, db, {
        order,
        station,
        by: { kind: "worker", acting },
        later: (state) => workEntry(request, { station, state, branch }),
      });
      return { recorded: request.act };
    }
  }
}

type TurnServed = {
  readonly stop: Stop | null;
  readonly ended: Awaited<Spawned["ended"]>;
};

type Stop = TurnStop | { readonly kind: "fault"; readonly error: unknown };

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
  const answer = (line: string): string => {
    if (stopped.cause !== null)
      return JSON.stringify(replyTo(refuseStation("turn_stopped", { order, station }), misses).reply);
    if (served.config.putBack()) {
      stopWith({ kind: "config_changed" });
      const changed = refuseStation("git_config_changed", { order, station, config: served.config.path });
      return JSON.stringify(replyTo(changed, misses).reply);
    }
    try {
      const request = requestOf(line);
      const result = served.turn.trace.step("act", { act: request.act }, () => serve(served, request));
      return JSON.stringify({ ok: true, result });
    } catch (error) {
      if (!isRefusal(error)) {
        stopWith({ kind: "fault", error });
        return JSON.stringify(replyTo(refuseStation("turn_stopped", { order, station }), misses).reply);
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

type Closing = TurnClose & { readonly acting: Acting };

function installDependencies(db: Database, turn: TurnOf, dir: string): void {
  const command = installCommand(dir);
  if (command === null) return;
  const { trace, order, station, cause } = turn;
  const installed = install(trace, dir, command.commandLine, turn.env);
  if (installed.exitCode === 0) return;
  recordStop({
    record: (later) =>
      recordAt(trace, db, { order, station, by: { kind: "factory", cause }, later: () => later }),
    order,
    stop: {
      action: "station_failed",
      code: "install_failed",
      details: { command: command.commandLine, output: installed.output },
    },
    refuse: refuseStation,
  });
}

function settleLostSubmission(db: Database, turn: TurnOf): void {
  const { submitted, project } = orderState(db, turn.order);
  if (submitted === null) return;
  const workspace = workspaceOf(project, turn.order);
  settleSubmission(db, { trace: turn.trace, order: turn.order, workspace, env: turn.env }, submitted);
}

async function runTurn(db: Database, turn: TurnOf): Promise<Closing> {
  settleLostSubmission(db, turn);
  const state = orderState(db, turn.order);
  const { station } = turn;
  const { head } = state;
  invariant(head !== null, `order ${turn.order} has a recorded head once its workspace is made`);
  const { worker, sessions } = stationWorker(db, {
    role: roleAt(station),
    project: state.project,
    order: turn.order,
    createdBy: turn.by.worker.name,
  });
  const copies = workerSessionsDir(worker.name);
  const session = sessionOf(sessions, state.died);
  const workspace = workspaceOf(state.project, turn.order);
  const { dir } = workspace;
  const { trace } = turn;
  alignBranch(trace, workspace, head);
  installDependencies(db, turn, dir);
  const opened = openTurn(trace, workerHomeDir(worker.name));
  try {
    if (session.kind === "fork") {
      restoreSession(trace, copies, session.from, WORKER_HARNESS.transcript(opened.home, dir, session.from));
    }
    const spawned = spawnFor(turn, session, dir, opened);
    const acting: Acting = { worker, session: openSession(db, turn, worker, session, spawned.pid) };
    const stopFollowing = followUsage(db, WORKER_HARNESS.transcript(opened.home, dir, idOf(session)));
    let served: TurnServed;
    try {
      served = await serveTurn(
        { db, turn, workspace, acting, config: guardFile(trace, turn.gitConfig) },
        spawned,
        opened.socket,
        turn.purpose.prompt({ state, workspace: dir, diff: diffOf(turn, head), check: checkOf(turn, dir) }),
      );
    } finally {
      stopFollowing();
    }
    const { stop } = served;
    if (stop?.kind === "fault") throw stop.error;
    const id = idOf(session);
    const outcome = WORKER_HARNESS.outcome(served.ended, startOf(session));
    const transcript = WORKER_HARNESS.transcript(opened.home, dir, id);
    if (outcome.kind === "finished" || sessionWritten(transcript)) {
      copySession(trace, transcript, WORKER_HARNESS.subagents(opened.home, dir, id), copies, id);
    }
    return {
      acting,
      session: id,
      stop,
      outcome,
      copied: sessionHeld(copies, id),
      resumed: session.kind === "resume",
    };
  } finally {
    closeTurn(trace, opened);
  }
}

function diffOf(turn: TurnOf, head: string): string | null {
  return turn.purpose.briefsDiff ? diffSince(turn.checkout, turn.defaultBranch, head) : null;
}

function checkOf(turn: TurnOf, workspace: string): string | null {
  if (!turn.purpose.briefsCheck) return null;
  return checkTask(workspace)?.commandLine ?? null;
}

function spawnFor(turn: TurnOf, session: SessionOf, workspace: string, opened: Turn): Spawned {
  const argv = WORKER_HARNESS.argv({
    session: startOf(session),
    model: turn.model,
    instructions: stationInstructions(turn.station),
    policy: policyOf(turn.purpose.policy, { workspace, checkoutGit: turn.checkoutGit, turn: opened }),
    socket: opened.socket,
  });
  const env = workerEnv(turn.env, opened, turn.identity, WORKER_HARNESS);
  return startHarness(turn.trace, { argv, cwd: workspace, env, session: idOf(session) });
}

function settleTurn(db: Database, turn: TurnOf, closing: Closing): Ended {
  return writeTransaction(db, () => {
    const state = orderState(db, turn.order);
    const { ended, record } = closedTurn(state, turn.station, turn.purpose.answers, closing);
    for (const later of record) recordAs(turn.trace, db, turn.order, byFactory(turn), later);
    if (ended.end === "replied") {
      recordAs(
        turn.trace,
        db,
        turn.order,
        { kind: "worker", acting: closing.acting },
        { action: "message_sent", details: { to: turn.by.worker.name, text: ended.reply } },
      );
    }
    return ended;
  });
}

type Prepared = {
  readonly model: string;
  readonly identity: Identity;
};

function prepareTurn(setup: ProjectSetup, station: Station, env: Env): Prepared {
  const role = roleAt(station);
  const model = modelOf(setup.config.models, role);
  if (model === null) throw refuseStation("no_model", { role, file: userConfigPath() });
  const { name, signIn } = WORKER_HARNESS;
  if (!signIn.some((variable) => env[variable]))
    throw refuseStation("no_sign_in", { harness: name, names: signIn });
  return { model, identity: ownerIdentity(setup.root, env) };
}

async function turnAt(db: Database, turn: TurnOf): Promise<string | null> {
  const first = settleTurn(db, turn, await runTurn(db, turn));
  const ended = first.end === "lost" ? settleTurn(db, turn, await runTurn(db, turn)) : first;
  const { order, station } = turn;
  invariant(ended.end !== "lost", `order ${order}'s replacement session is a fork, never a resume`);
  switch (ended.end) {
    case "returned":
      return null;
    case "replied":
      return ended.reply;
    case "closed": {
      if (turn.purpose.answers === "return") return null;
      const refusal = stepRefusal(orderState(db, order), "message");
      invariant(refusal !== null, `order ${order} admits no message once it is closed`);
      throw refusal;
    }
    case "config_changed":
      throw refuseStation("git_config_changed", { order, station, config: turn.gitConfig });
    case "died":
      throw refuseStation("session_died", { order, station, session: ended.session, code: ended.code });
    case "no_return":
      throw refuseStation("no_return", { order, station, session: ended.session });
    case "no_reply":
      throw refuseStation("no_reply", { order, station, session: ended.session });
    case "missed":
      throw refuseStation("return_missed", { order, station, missed: ended.missed });
    default:
      return unreachable(ended);
  }
}

type Running = {
  readonly trace: Trace;
  readonly env: Env;
  readonly setup: ProjectSetup;
  readonly cause: number;
  readonly state: OrderState;
  turnOf(station: Station, purpose: Purpose): TurnOf;
};

type NewWorkspace = {
  readonly root: string;
  readonly project: string;
  readonly order: string;
  readonly base: string;
  readonly cause: number;
};

function madeWorkspace(
  trace: Trace,
  db: Database,
  { root, project, order, base, cause }: NewWorkspace,
): OrderState {
  createWorkspace(trace, root, project, order, base);
  return recordAs(
    trace,
    db,
    order,
    { kind: "factory", cause },
    { action: "workspace_created", details: { base } },
  ).state;
}

async function withRun<T>(
  db: Database,
  order: string,
  caller: Caller,
  act: OperatorAct,
  station: Station | null,
  env: Env,
  body: (running: Running) => Promise<T>,
): Promise<T> {
  const trace = traceOf(order, env);
  return trace.stepAsync("run", { act: act.kind, station }, async () => {
    const { project } = orderState(db, order);
    const setup = projectSetup(db, project, caller.cwd);
    const runEnv = pinnedEnv(trace, order, setup.root, env);
    const prepared = station === null ? null : prepareTurn(setup, station, runEnv);
    const base = tipOf(setup.root, setup.branch);
    const { by, cause, created, state: started, orphan } = startRun(trace, db, order, caller, act);
    try {
      if (orphan !== null) stopHarness(trace, orphan);
      const state = created
        ? madeWorkspace(trace, db, { root: setup.root, project, order, base, cause })
        : started;
      return await body({
        trace,
        env: runEnv,
        setup,
        cause,
        state,
        turnOf: (at, purpose) => {
          const ready = at === station && prepared !== null ? prepared : prepareTurn(setup, at, runEnv);
          const checkoutGit = gitCommonDir(setup.root);
          return {
            trace,
            order,
            station: at,
            by,
            cause,
            checkout: setup.root,
            checkoutGit,
            gitConfig: join(checkoutGit, "config"),
            defaultBranch: setup.branch,
            env: runEnv,
            purpose,
            ...ready,
          };
        },
      });
    } finally {
      endRun(db, order);
    }
  });
}

function stationAfter(state: OrderState, turn: Station): Station | null {
  const { phase } = state;
  if (phase.kind !== "run") return null;
  invariant(phase.station !== turn, `order ${state.id}'s ${turn} turn moved it to another phase`);
  return phase.station;
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
  await withRun(
    db,
    order,
    caller,
    act,
    station,
    env,
    async ({ trace, env: runEnv, setup, cause, state, turnOf }) => {
      if (station !== null) {
        for (let at: Station | null = station; at !== null; at = stationAfter(orderState(db, order), at)) {
          await turnAt(db, turnOf(at, stationPurpose(at)));
        }
        return;
      }
      invariant(expected?.kind === "ship", `order ${order} runs a station or ships after ${act.kind}`);
      await shipOrder(db, {
        trace,
        order,
        project: state.project,
        checkout: setup.root,
        defaultBranch: setup.branch,
        config: setup.config,
        cause,
        env: runEnv,
      });
    },
  );
}

export async function messageWorker(
  db: Database,
  order: string,
  caller: Caller,
  { station, text }: { readonly station: Station; readonly text: string },
  env: Env,
): Promise<string> {
  const worker = stationWorkerAt(db, order, roleAt(station));
  if (worker === null) throw refuseOrder("no_worker", { order, station });
  const act = { kind: "message", to: worker.name, text } as const;
  return withRun(db, order, caller, act, station, env, async ({ turnOf }) => {
    const reply = await turnAt(db, turnOf(station, messagePurpose(text)));
    invariant(reply !== null, `a message turn on order ${order} ends in a reply or a refusal`);
    return reply;
  });
}

export function cancelOrder(db: Database, order: string, caller: Caller, reason: string, env: Env): void {
  const trace = traceOf(order, env);
  trace.step("run", { act: "cancel", station: null }, () => {
    const { project, head } = orderState(db, order);
    const root = head === null ? null : projectCheckout(db, project, caller.cwd).root;
    const { harness } = recordCancel(trace, db, order, caller, reason);
    if (harness !== null) stopHarness(trace, harness);
    if (root === null) return;
    const kept = removeWorkspace(trace, root, workspaceOf(project, order));
    if (kept.length > 0) throw refuseOrder("workspace_kept", { order, root, kept });
  });
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
  return turnReplyOf(line);
}

export function turnReplyOf(line: string): unknown {
  if (line === "") throw refuseStation("no_turn", { detail: "the turn closed without replying" });
  const reply = TurnReply.parse(JSON.parse(line));
  if (reply.ok) return reply.result;
  throw refusalOf(reply.error);
}
