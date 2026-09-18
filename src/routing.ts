import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonc } from "./jsonc-file";
import { dataDir, type Env } from "./paths";

export type Tier = "cheap" | "standard" | "deep";

export const TIERS: Tier[] = ["cheap", "standard", "deep"];

/**
 * The roles the station skills already name, each given a tier here rather than
 * anywhere a caller could infer one: `cheap` reads one thing against a fixed
 * brief, `standard` makes the mechanical edit, `deep` cuts the work and decides
 * where the line stops.
 */
export const ROLE_TIERS = {
  driver: "deep",
  planner: "deep",
  builder: "standard",
  simplifier: "standard",
  reviewer: "standard",
  checker: "cheap",
  judge: "cheap",
  searcher: "cheap",
} as const satisfies Record<string, Tier>;

export type Role = keyof typeof ROLE_TIERS;

export const ROLES = Object.keys(ROLE_TIERS) as Role[];

export type HarnessMap = Record<Tier, string>;

/** `path` is the harness map, and is unset where the role rather than the file is wrong. */
export class RoutingError extends Error {
  constructor(
    readonly kind: "unknown-role" | "no-map" | "malformed",
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * One map per machine, beside the database rather than in any checkout: the same
 * stations driven from a different harness resolve to different models, and a
 * repo does not know which harness is driving it.
 */
export function harnessMapPath(env: Env = process.env): string {
  return join(dataDir(env), "routing.json");
}

const TEMPLATE = '{ "cheap": "<model>", "standard": "<model>", "deep": "<model>" }';

export function readHarnessMap(env: Env = process.env): HarnessMap {
  const path = harnessMapPath(env);
  if (!existsSync(path)) {
    throw new RoutingError(
      "no-map",
      `${path}: no harness map, so no role resolves to a model; write ${TEMPLATE} naming what this harness calls each tier`,
      path,
    );
  }
  const raw = readJsonc<unknown>(path);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RoutingError("malformed", `${path}: the harness map is not an object of ${TEMPLATE}`, path);
  }
  const entries = raw as Record<string, unknown>;
  const unknown = Object.keys(entries).filter((key) => !TIERS.includes(key as Tier));
  if (unknown.length > 0) {
    throw new RoutingError(
      "malformed",
      `${path}: names ${unknown.join(", ")}, which is no tier; the tiers are ${TIERS.join(", ")}`,
      path,
    );
  }
  const map = {} as HarnessMap;
  for (const tier of TIERS) {
    const name = entries[tier];
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new RoutingError("malformed", `${path}: the ${tier} tier names no model`, path);
    }
    map[tier] = name.trim();
  }
  return map;
}

export function route(role: string, env: Env = process.env): { tier: Tier; model: string } {
  if (!(role in ROLE_TIERS)) {
    throw new RoutingError(
      "unknown-role",
      `${role}: no such factory role; the roles are ${ROLES.join(", ")}`,
    );
  }
  const tier = ROLE_TIERS[role as Role];
  return { tier, model: readHarnessMap(env)[tier] };
}

export function routeReport(role: string | undefined, env: Env = process.env): string[] {
  if (role !== undefined) {
    const { tier, model } = route(role, env);
    return [`${tier} ${model}`];
  }
  const map = readHarnessMap(env);
  return [
    ...ROLES.map((r) => `${r}\t${ROLE_TIERS[r]}\t${map[ROLE_TIERS[r]]}`),
    "",
    `harness map: ${harnessMapPath(env)}`,
  ];
}
