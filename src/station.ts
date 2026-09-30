import { listedEnv, PASSED_THROUGH } from "./check";
import type { Models } from "./config";
import type { OrderState } from "./order";
import { type Later, Plan, type Station } from "./order-contract";
import type { Env } from "./paths";
import { type PlanReturn, refuseStation, TurnRequest } from "./station-contract";
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
    returned: null,
    committed: state.commits,
  });
}

type WorkRequest = Exclude<TurnRequest, { readonly act: "order_show" }>;

type Work<R> = { readonly station: Station; readonly command: string; entry(request: R): Later };

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

export const WORK: { readonly [A in WorkRequest["act"]]: Work<Extract<WorkRequest, { readonly act: A }>> } = {
  plan_return: {
    station: "plan",
    command: PLAN_RETURN,
    entry: (request: PlanReturn) => ({ action: "plan_returned", details: planOf(request.plan, PLAN_RETURN) }),
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

export type TurnEnd = "returned" | "no_return" | "closed";

export function turnEnd(state: OrderState, station: Station): TurnEnd {
  if (state.status !== "running") return "closed";
  const { phase } = state;
  return phase.kind === "run" && phase.station === station ? "no_return" : "returned";
}
