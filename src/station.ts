import { unreachable } from "./assert";
import { listedEnv, PASSED_THROUGH } from "./check";
import type { Models } from "./config";
import type { OrderState } from "./order";
import { type Later, Plan, type Station } from "./order-contract";
import type { Env } from "./paths";
import { type OrderReturn, type PlanReturn, refuseStation, TurnRequest } from "./station-contract";
import type { StationRole } from "./worker-contract";

export const TURN_SOCKET_ENV = "DIM_TURN_SOCKET";

export const SKILLS: Readonly<Record<Station, string>> = {
  plan: "dim-plan",
  build: "dim-build",
  review: "dim-review",
};

export function modelOf(models: Models | undefined, role: StationRole): string | null {
  return models?.[role] ?? models?.default ?? null;
}

const XDG = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const;

export type Turn = {
  readonly dir: string;
  readonly home: string;
  readonly tmp: string;
  readonly socket: string;
};

export function workerEnv(owner: Env, turn: Turn, signIn: readonly string[]): Record<string, string> {
  return {
    ...listedEnv(owner, [...PASSED_THROUGH, ...XDG, ...signIn]),
    HOME: turn.home,
    TMPDIR: turn.tmp,
    [TURN_SOCKET_ENV]: turn.socket,
  };
}

export type Policy = {
  readonly kind: "read";
  readonly writable: readonly string[];
  readonly denied: readonly string[];
};

export function readPolicy(workspace: string, turn: Turn): Policy {
  return { kind: "read", writable: [turn.tmp], denied: [workspace] };
}

export function planBrief(state: OrderState, workspace: string): string {
  return JSON.stringify({
    skill: SKILLS.plan,
    order: { id: state.id, title: state.title, project: state.project, description: state.description },
    workspace,
    returned: state.returned,
    committed: state.commits,
  });
}

export type WorkRequest = Exclude<TurnRequest, { readonly act: "order_show" }>;

type Work<R> = {
  readonly stations: readonly Station[];
  readonly command: string;
  entry(request: R, station: Station): Later;
};

export const STATIONS: readonly Station[] = ["plan", "build", "review"];

function planOf(text: string, command: string): Plan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refuseStation("not_done", { station: "plan", missed: `the plan is not JSON: ${error}`, command });
  }
  const plan = Plan.safeParse(raw);
  if (plan.success) return plan.data;
  const missed = plan.error.issues.map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`);
  throw refuseStation("not_done", { station: "plan", missed: missed.join("; "), command });
}

const PLAN_RETURN = "dim plan return <file>";

const ORDER_RETURN = "dim order return --reason <reason>";

function reasonOf(reason: string, command: string): string {
  if (reason.trim() === "") throw refuseStation("no_reason", { command });
  return reason;
}

export const WORK: { readonly [A in WorkRequest["act"]]: Work<Extract<WorkRequest, { readonly act: A }>> } = {
  plan_return: {
    stations: ["plan"],
    command: PLAN_RETURN,
    entry: (request: PlanReturn) => ({ action: "plan_returned", details: planOf(request.plan, PLAN_RETURN) }),
  },
  order_return: {
    stations: STATIONS,
    command: ORDER_RETURN,
    entry: (request: OrderReturn, station) => ({
      action: "order_returned",
      details: { station, reason: reasonOf(request.reason, ORDER_RETURN) },
    }),
  },
};

export function requestOf(line: string): TurnRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw refuseStation("bad_request", { issues: `not JSON: ${error}` });
  }
  const request = TurnRequest.safeParse(raw);
  if (request.success) return request.data;
  throw refuseStation("bad_request", {
    issues: request.error.issues.map((issue) => issue.message).join("; "),
  });
}

function entryAt<R>(work: Work<R>, request: R, station: Station): Later {
  if (!work.stations.includes(station)) throw refuseStation("wrong_station", { act: work.command, station });
  return work.entry(request, station);
}

export function workEntry(request: WorkRequest, station: Station): Later {
  switch (request.act) {
    case "plan_return":
      return entryAt(WORK.plan_return, request, station);
    case "order_return":
      return entryAt(WORK.order_return, request, station);
    default:
      return unreachable(request);
  }
}

export type TurnEnd = "returned" | "no_return" | "closed";

export function turnEnd(state: OrderState, station: Station): TurnEnd {
  if (state.status !== "running") return "closed";
  const { phase } = state;
  return phase.kind === "run" && phase.station === station ? "no_return" : "returned";
}
