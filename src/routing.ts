import { existsSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, type HarnessName } from "./harness-name";
import { duplicateKeys, parseJsonc } from "./jsonc";
import { readJsoncText } from "./jsonc-file";
import { dataDir, type Env } from "./paths";
import { ROLES, type Role } from "./roles";

export type Tier = "light" | "standard" | "deep";

export const TIERS: Tier[] = ["light", "standard", "deep"];

/**
 * A tier for every role, rather than anywhere a caller could infer one: `light` reads one
 * thing against a fixed brief, `standard` makes the mechanical edit, `deep` cuts the work
 * and decides where the line stops. Keyed by `Role`, so a role added to the vocabulary
 * does not compile until it is given a tier here.
 */
export const ROLE_TIERS = {
  operator: "deep",
  planner: "deep",
  builder: "standard",
  reviewer: "deep",
} as const satisfies Record<Role, Tier>;

export type HarnessMap = Record<Tier, string>;
export type RoutingMap = Record<HarnessName, HarnessMap>;
export type RouteRecord = { harness: HarnessName; role: Role; tier: Tier; model: string };

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

const TEMPLATE = '{ "codex": { "light": "<model>", "standard": "<model>", "deep": "<model>" } }';

export function readHarnessMap(harness: HarnessName, env: Env = process.env): HarnessMap {
  const path = harnessMapPath(env);
  if (!existsSync(path)) {
    throw new RoutingError(
      "no-map",
      `${path}: no harness map, so no role resolves to a model; write ${TEMPLATE} naming what this harness calls each tier`,
      path,
    );
  }
  const text = readJsoncText(path);
  const repeated = duplicateKeys(text, { deep: true });
  if (repeated.length > 0) {
    throw new RoutingError(
      "malformed",
      `${path}: names ${repeated.join(", ")} twice, so one model silently replaced another`,
      path,
    );
  }
  const raw = parseJsonc<unknown>(text, path);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RoutingError("malformed", `${path}: the harness map is not an object of ${TEMPLATE}`, path);
  }
  const maps = raw as Record<string, unknown>;
  const unknownHarnesses = Object.keys(maps).filter((key) => !HARNESSES.includes(key as HarnessName));
  if (unknownHarnesses.length > 0) {
    throw new RoutingError(
      "malformed",
      `${path}: names ${unknownHarnesses.join(", ")}, which is no supported harness`,
      path,
    );
  }
  const selected = maps[harness];
  if (!(harness in maps)) {
    throw new RoutingError("malformed", `${path}: no map for the ${harness} harness`, path);
  }
  if (selected === null || typeof selected !== "object" || Array.isArray(selected)) {
    throw new RoutingError(
      "malformed",
      `${path}: the ${harness} harness map is not an object of tiers`,
      path,
    );
  }
  const entries = selected as Record<string, unknown>;
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

export function route(
  role: string,
  harness: HarnessName,
  env: Env = process.env,
): { tier: Tier; model: string } {
  if (!(role in ROLE_TIERS)) {
    throw new RoutingError(
      "unknown-role",
      `${role}: no such factory role; the roles are ${ROLES.join(", ")}`,
    );
  }
  const tier = ROLE_TIERS[role as Role];
  return { tier, model: readHarnessMap(harness, env)[tier] };
}

export function routeReport(
  harness: HarnessName,
  role: string | undefined,
  env: Env = process.env,
): RouteRecord[] {
  if (role !== undefined) {
    const { tier, model } = route(role, harness, env);
    return [{ harness, role: role as Role, tier, model }];
  }
  const map = readHarnessMap(harness, env);
  return ROLES.map((r) => ({ harness, role: r, tier: ROLE_TIERS[r], model: map[ROLE_TIERS[r]] }));
}
