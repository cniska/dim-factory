import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { HARNESSES } from "./harness-name";
import { ROLES } from "./roles";
import { harnessMapPath, ROLE_TIERS, RoutingError, route, routeReport } from "./routing";

function machine(map?: string): { DIM_HOME: string } {
  const home = mkdtempSync(join(tmpdir(), "dim-routing-"));
  if (map !== undefined) writeFileSync(join(home, "routing.json"), map);
  return { DIM_HOME: home };
}

const COMPLETE = '{ "codex": { "light": "small", "standard": "middling", "deep": "large" } }';

describe("resolving a role", () => {
  // Written out rather than read off ROLE_TIERS: a test that asks the table
  // whether it agrees with itself ratifies whatever the table is changed to,
  // and these assignments are what docs/factory.md argues.
  test("every role runs at the tier the factory declares for it", () => {
    const env = machine(COMPLETE);

    expect(route("operator", "codex", env)).toEqual({ tier: "deep", model: "large" });
    expect(route("planner", "codex", env)).toEqual({ tier: "deep", model: "large" });
    expect(route("builder", "codex", env)).toEqual({ tier: "standard", model: "middling" });
    expect(route("reviewer", "codex", env)).toEqual({ tier: "deep", model: "large" });
  });

  test("declares no role the report cannot print", () => {
    expect(ROLES).toEqual(["operator", "planner", "builder", "reviewer"]);
  });

  test("refuses a role no station names", () => {
    const env = machine(COMPLETE);

    expect(() => route("inspector", "codex", env)).toThrow(/no such factory role/);
    try {
      route("inspector", "codex", env);
    } catch (e) {
      expect(e).toBeInstanceOf(RoutingError);
      expect((e as RoutingError).kind).toBe("unknown-role");
    }
  });

  test("the listing names every role and the map it read", () => {
    const env = machine(COMPLETE);
    const report = routeReport("codex", undefined, env);

    expect(report).toEqual(
      ROLES.map((role) => ({
        harness: "codex",
        role,
        tier: ROLE_TIERS[role],
        model: role === "builder" ? "middling" : "large",
      })),
    );
    expect(harnessMapPath(env)).toContain(env.DIM_HOME);
  });

  test("prints the tier and the model on one line", () => {
    expect(routeReport("codex", "reviewer", machine(COMPLETE))).toEqual([
      { harness: "codex", role: "reviewer", tier: "deep", model: "large" },
    ]);
  });
});

describe("a map that cannot be trusted", () => {
  test("refuses to route where no map was written", () => {
    const env = machine();

    try {
      route("reviewer", "codex", env);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RoutingError);
      expect((e as RoutingError).kind).toBe("no-map");
      expect((e as RoutingError).path).toBe(harnessMapPath(env));
      expect((e as Error).message).toContain('"standard"');
    }
  });

  test("refuses a map that is not an object of tiers", () => {
    expect(() => route("reviewer", "codex", machine('{ "codex": ["small", "large"] }'))).toThrow(
      /not an object/,
    );
  });

  test("refuses a tier the map leaves unnamed", () => {
    expect(() =>
      route("reviewer", "codex", machine('{ "codex": { "light": "small", "standard": "middling" } }')),
    ).toThrow(/the deep tier names no model/);
    expect(() =>
      route("reviewer", "codex", machine('{ "codex": { "light": " ", "standard": "m", "deep": "l" } }')),
    ).toThrow(/the light tier names no model/);
  });

  // Every tier is named here, so the only thing wrong with this map is the stray
  // key; a fixture that also left a tier unnamed would redden on that instead.
  test("refuses a key that is no tier, which is how a typo is caught", () => {
    const env = machine('{ "codex": { "light": "s", "standard": "m", "deep": "l", "lite": "x" } }');

    expect(() => route("reviewer", "codex", env)).toThrow(/lite, which is no tier/);
  });

  test("refuses a tier named twice, which JSON would silently resolve", () => {
    const env = machine('{ "codex": { "light": "first", "light": "second", "standard": "m", "deep": "l" } }');

    expect(() => route("reviewer", "codex", env)).toThrow(/names codex\.light twice/);
  });
});

// The point of the map is that only it knows a model, so a name reaching the
// code or a skill would route by itself and the map would stop being read.
// Tests and transcript fixtures are excluded: a parsed transcript carries the
// model a session ran on, which is a recorded fact rather than a routing choice.
test("no model name reaches dim's source or a skill", () => {
  const root = join(import.meta.dir, "..");
  const suspect = /haiku|sonnet|opus|gpt-|gemini/i;
  const offenders: string[] = [];
  for (const pattern of ["src/**/*.ts", "src/**/*.tsx", "skills/**/*.md"]) {
    for (const file of new Glob(pattern).scanSync(root)) {
      if (file.includes(".test.") || file.includes(".test-support.")) continue;
      if (suspect.test(readFileSync(join(root, file), "utf8"))) offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});

// A skill names a role in prose, where a typo reads as fine and resolves to
// nothing until the station runs; this is the mechanical half of "a skill cites
// only queries that answer".
test("every role a skill cites is one that routes", () => {
  const root = join(import.meta.dir, "..");
  const cited: string[] = [];
  const unroutable: string[] = [];
  for (const file of new Glob("skills/**/*.md").scanSync(root)) {
    for (const [, harness, role] of readFileSync(join(root, file), "utf8").matchAll(
      /dim route (<harness>|\w+) (\w+)/g,
    )) {
      cited.push(`${harness}:${role}`);
      const harnessRoutes =
        harness === "<harness>" || (HARNESSES as readonly string[]).includes(harness as string);
      if (!harnessRoutes || !((role as string) in ROLE_TIERS)) {
        unroutable.push(`${file}: ${harness} ${role}`);
      }
    }
  }

  expect(unroutable).toEqual([]);
  expect(cited.length).toBeGreaterThan(0);
});
