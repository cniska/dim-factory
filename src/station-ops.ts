import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { errorRecord } from "./cli-output";
import { refusalOf } from "./coded-error";
import { readConfig, userConfigPath } from "./config";
import { writeTransaction } from "./db";
import { adapterFor, startHarness } from "./harness-ops";
import { ROLE_AT } from "./order";
import { Plan, refuseOrder, type Station } from "./order-contract";
import { endRun, markHarness, orderState, recordFactory, recordWork, showOrder, startRun } from "./order-ops";
import { type Env, workerHomeDir, workerSessionsDir } from "./paths";
import { checkoutOf, defaultBranch } from "./project";
import { modelOf, planBrief, TURN_SOCKET_ENV, workerEnv } from "./station";
import { refuseStation, TurnReply, TurnRequest } from "./station-contract";
import { copySession, listen, makeHome, openTurnDir, removeTurnDir, send } from "./station-effects";
import type { Acting, Caller, WorkerSession } from "./worker-contract";
import { processOf, registerSession, stationWorker } from "./worker-ops";
import { baseOf, createWorkspace, workspaceOf } from "./workspace-ops";

type Setup = { readonly root: string; readonly branch: string };

function setupOf(db: Database, project: string, cwd: string): Setup {
  const checkout = checkoutOf(db, project, cwd);
  if (checkout === null) throw refuseOrder("no_checkout", { project });
  const branch = defaultBranch(checkout.root);
  if (branch === null) throw refuseOrder("no_default_branch", { checkout: checkout.root });
  return { root: checkout.root, branch };
}

type TurnOf = {
  readonly order: string;
  readonly station: Station;
  readonly by: Acting;
  readonly cause: number;
  readonly model: string;
  readonly newSessionHarness: string;
};

function planReturned(text: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refuseStation("not_done", { station: "plan", missed: `the plan is not JSON: ${String(error)}` });
  }
  const plan = Plan.safeParse(raw);
  if (!plan.success) {
    const missed = plan.error.issues.map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`);
    throw refuseStation("not_done", { station: "plan", missed: missed.join("; ") });
  }
  return plan.data;
}

async function runTurn(db: Database, turn: TurnOf): Promise<void> {
  const state = orderState(db, turn.order);
  const { model } = turn;
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
  const home = makeHome(workerHomeDir(worker.name));
  const dir = openTurnDir();
  let acting: Acting | null = null;
  let returned = false;
  const serve = (request: TurnRequest): unknown => {
    invariant(acting !== null, "a turn serves acts only once its session is registered");
    if (request.act === "order_show") return showOrder(db, turn.order);
    recordWork(db, turn.order, acting, turn.station, {
      action: "plan_returned",
      details: planReturned(request.plan),
    });
    returned = true;
    return { recorded: "plan_returned" };
  };
  const listening = listen(dir.socket, async (line) => {
    try {
      return JSON.stringify({ ok: true, result: serve(TurnRequest.parse(JSON.parse(line))) });
    } catch (error) {
      return JSON.stringify({ ok: false, error: errorRecord(error, "usage: dim plan return <file>") });
    }
  });
  try {
    const argv = adapter.argv({ session, model, workspace, tmp: dir.tmp, socket: dir.socket });
    const held = startHarness(argv, workspace, workerEnv(process.env, { home, ...dir }, adapter.signIn));
    const harnessProcess = processOf(held.pid);
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
    acting = { worker, session: registered };
    held.release(planBrief(state, workspace));
    await held.ended;
    if (!returned) {
      recordFactory(db, turn.order, turn.cause, {
        action: "station_failed",
        code: "no_return",
        details: { session: session.id },
      });
    }
    copySession(adapter.transcript(home, workspace, session.id), workerSessionsDir(worker.name), session.id);
  } finally {
    listening.stop();
    removeTurnDir(dir);
  }
}

export async function runOrder(db: Database, order: string, caller: Caller, cwd: string): Promise<void> {
  const { project, phase } = orderState(db, order);
  invariant(phase.kind === "run", `order ${order} runs a station; shipping is not built`);
  const setup = setupOf(db, project, cwd);
  const config = readConfig({ root: setup.root, at: setup.branch });
  const role = ROLE_AT[phase.station];
  const model = modelOf(config.models, role);
  if (model === null) throw refuseStation("no_model", { role, file: userConfigPath() });
  const newSessionHarness = config.harness;
  if (newSessionHarness === undefined) throw refuseStation("harness_unset", { project });
  const base = baseOf(setup.root, setup.branch);
  const { by, cause, created } = startRun(db, order, caller, base);
  try {
    if (created) createWorkspace(setup.root, project, order, base);
    await runTurn(db, { order, station: phase.station, by, cause, model, newSessionHarness });
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
  const reply = TurnReply.parse(JSON.parse(line));
  if (reply.ok) return reply.result;
  throw refusalOf(reply.error);
}
