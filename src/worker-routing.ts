import { join } from "node:path";
import { readSettingFile } from "./config-setting-file";
import { type HarnessName, isHarness } from "./harness-name";
import { dataDir, type Env } from "./paths";
import { fail } from "./worker-contract";
import { ROLES, type Role } from "./worker-roles";

export type Tier = "light" | "standard" | "deep";

export const TIERS: Tier[] = ["light", "standard", "deep"];

export const ROLE_TIERS = {
  operator: "deep",
  planner: "deep",
  builder: "standard",
  reviewer: "deep",
} as const satisfies Record<Role, Tier>;

export type HarnessMap = Record<Tier, string>;
export type RoutingMap = Record<HarnessName, HarnessMap>;
export type RouteRecord = { harness: HarnessName; role: Role; tier: Tier; model: string };

export function harnessMapPath(env: Env = process.env): string {
  return join(dataDir(env), "routing.json");
}

const templateFor = (harness: HarnessName): string =>
  `{ "${harness}": { "light": "<model>", "standard": "<model>", "deep": "<model>" } }`;

export function readHarnessMap(harness: HarnessName, env: Env = process.env): HarnessMap {
  const found = findHarnessMap(harness, env);
  if ("missing" in found) {
    throw fail("routing_no_map", {
      path: harnessMapPath(env),
      harness,
      template: templateFor(harness),
      missing: found.missing,
    });
  }
  return found.map;
}

export function findHarnessMap(
  harness: HarnessName,
  env: Env = process.env,
): { map: HarnessMap } | { missing: "file" | "harness" } {
  const template = templateFor(harness);
  const path = harnessMapPath(env);
  const maps = readSettingFile(path, {
    isKey: isHarness,
    refuse: (defect) =>
      defect.kind === "duplicate-key"
        ? fail("routing_duplicate_key", { path, keys: defect.keys })
        : defect.kind === "not-object"
          ? fail("routing_not_object", { path, template })
          : fail("routing_unknown_harness", { path, keys: defect.keys }),
  });
  if (maps === null) return { missing: "file" };
  const selected = maps[harness];
  if (!(harness in maps)) return { missing: "harness" };
  if (selected === null || typeof selected !== "object" || Array.isArray(selected)) {
    throw fail("routing_harness_not_object", { path, harness });
  }
  const entries = selected as Record<string, unknown>;
  const unknown = Object.keys(entries).filter((key) => !TIERS.includes(key as Tier));
  if (unknown.length > 0) {
    throw fail("routing_unknown_tier", { path, unknown, tiers: TIERS });
  }
  const map = {} as HarnessMap;
  for (const tier of TIERS) {
    const name = entries[tier];
    if (typeof name !== "string" || name.trim().length === 0) {
      throw fail("routing_tier_unnamed", { path, tier });
    }
    map[tier] = name.trim();
  }
  return { map };
}

export function route(
  role: string,
  harness: HarnessName,
  env: Env = process.env,
): { tier: Tier; model: string } {
  if (!(role in ROLE_TIERS)) {
    throw fail("routing_unknown_role", { role, roles: ROLES });
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
