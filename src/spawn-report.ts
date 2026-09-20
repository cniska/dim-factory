import type { Capability } from "./capabilities";
import { PLANNER_CAPABILITIES } from "./order-plan";
import { REVIEWER_CAPABILITIES } from "./order-review";
import type { Env } from "./paths";
import type { Role } from "./roles";
import { route } from "./routing";
import { readSpawnProfile, spawnArgv, spawnProfilePath } from "./spawn-profile";

/**
 * Only the roles a station has already declared a capability set for. `builder`
 * and `operator` are not spawned through this mechanism yet — that is
 * `worker-spawner`'s job, not this file's.
 */
const CAPABILITIES_BY_ROLE: Partial<Record<Role, Capability[]>> = {
  planner: PLANNER_CAPABILITIES,
  reviewer: REVIEWER_CAPABILITIES,
};

const ELIDED_BRIEF = "<brief>";

function spawnLine(role: string, env: Env): string {
  const capabilities = CAPABILITIES_BY_ROLE[role as Role];
  if (!capabilities) {
    const spawnable = Object.keys(CAPABILITIES_BY_ROLE);
    throw new Error(`${role}: no capability set is declared for this role yet; ${spawnable.join(", ")} are`);
  }
  const { model } = route(role, env);
  const profile = readSpawnProfile(env);
  return spawnArgv(profile, { model, brief: ELIDED_BRIEF, capabilities }).join(" ");
}

/** The symmetric command to `routeReport`: what a station would be started with, brief
 *  elided, so an operator reads the argv a spawn would use instead of retyping it by hand. */
export function spawnReport(role: string | undefined, env: Env = process.env): string[] {
  if (role !== undefined) return [spawnLine(role, env)];
  return [
    ...Object.keys(CAPABILITIES_BY_ROLE).map((r) => `${r}\t${spawnLine(r, env)}`),
    "",
    `spawn profile: ${spawnProfilePath(env)}`,
  ];
}
