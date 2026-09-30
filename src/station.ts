import { listedEnv, PASSED_THROUGH } from "./check";
import type { Models } from "./config";
import type { OrderState } from "./order";
import type { Station } from "./order-contract";
import type { Env } from "./paths";
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
    skill: SKILLS.plan,
    order: { id: state.id, title: state.title, project: state.project, description: state.description },
    workspace,
    returned: null,
    committed: state.commits,
  });
}
