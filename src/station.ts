import { listedEnv, PASSED_THROUGH } from "./check";
import type { Strength } from "./harness-contract";
import type { OrderState } from "./order";
import type { Station } from "./order-contract";
import type { Env } from "./paths";

export const TURN_SOCKET_ENV = "DIM_TURN_SOCKET";

type StationDefinition = { readonly skill: string; readonly strength: Strength };

export const STATIONS: Readonly<Record<Station, StationDefinition>> = {
  plan: { skill: "dim-plan", strength: "deep" },
  build: { skill: "dim-build", strength: "standard" },
  review: { skill: "dim-review", strength: "deep" },
};

const XDG = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const;

export type Turn = { readonly home: string; readonly tmp: string; readonly socket: string };

export function workerEnv(owner: Env, turn: Turn, signIn: readonly string[]): Record<string, string> {
  return {
    ...listedEnv(owner, [...PASSED_THROUGH, ...XDG, ...signIn]),
    HOME: turn.home,
    TMPDIR: turn.tmp,
    [TURN_SOCKET_ENV]: turn.socket,
  };
}

export function planBrief(state: OrderState, workspace: string): string {
  return JSON.stringify({
    skill: STATIONS.plan.skill,
    order: { id: state.id, title: state.title, project: state.project, description: state.description },
    workspace,
    returned: null,
    committed: state.commits,
  });
}
