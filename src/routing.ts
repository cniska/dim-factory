import { join } from "node:path";
import { type HarnessName, isHarness } from "./harness-name";
import { dataDir, type Env } from "./paths";
import { ROLES, type Role } from "./roles";
import { readSettingFile } from "./setting-file";

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

export function readHarnessMap(harness: HarnessName, env: Env = process.env): HarnessMap {
  const template = `{ "${harness}": { "light": "<model>", "standard": "<model>", "deep": "<model>" } }`;
  const path = harnessMapPath(env);
  const maps = readSettingFile(path, {
    isKey: isHarness,
    refuse: (defect) =>
      new RoutingError(
        "malformed",
        defect.kind === "duplicate-key"
          ? `${path}: names ${defect.keys.join(", ")} twice, so one model silently replaced another`
          : defect.kind === "not-object"
            ? `${path}: the harness map is not an object of ${template}`
            : `${path}: names ${defect.keys.join(", ")}, which is no supported harness`,
        path,
      ),
  });
  if (maps === null) {
    throw new RoutingError(
      "no-map",
      `${path}: no harness map, so no role resolves to a model; write ${template} naming what this harness calls each tier`,
      path,
    );
  }
  const selected = maps[harness];
  if (!(harness in maps)) {
    throw new RoutingError("no-map", `${path}: no map for the ${harness} harness; add ${template}`, path);
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
