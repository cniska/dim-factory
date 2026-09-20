import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSpawnProfile,
  type SpawnProfile,
  SpawnProfileError,
  spawnArgv,
  spawnProfilePath,
} from "./spawn-profile";

function machine(profile?: string): { DIM_HOME: string } {
  const home = mkdtempSync(join(tmpdir(), "dim-spawn-"));
  if (profile !== undefined) writeFileSync(join(home, "spawn.json"), profile);
  return { DIM_HOME: home };
}

const CLAUDE_PROFILE = JSON.stringify({
  argv: ["claude", "-p", "{brief}", "--model", "{model}", "--allowedTools", "{tools}"],
  slots: { tools: { join: "," } },
  grants: {
    "read-files": { tools: ["Read", "Grep", "Glob"] },
    "read-history": { tools: ["Bash(git diff:*)"] },
    "ask-dim": { tools: ["Bash(dim q:*)"] },
    "raise-finding": { tools: ["Bash(dim order finding:*)"] },
  },
});

describe("reading a spawn profile", () => {
  test("reads argv, slots and grants off the file beside the database", () => {
    const env = machine(CLAUDE_PROFILE);

    const profile = readSpawnProfile(env);

    expect(profile.argv).toEqual([
      "claude",
      "-p",
      "{brief}",
      "--model",
      "{model}",
      "--allowedTools",
      "{tools}",
    ]);
    expect(profile.slots).toEqual({ tools: { join: "," } });
    expect(profile.grants["read-files"]).toEqual({ tools: ["Read", "Grep", "Glob"] });
  });

  test("refuses to read where no profile was written", () => {
    const env = machine();

    try {
      readSpawnProfile(env);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SpawnProfileError);
      expect((e as SpawnProfileError).kind).toBe("no-profile");
      expect((e as SpawnProfileError).path).toBe(spawnProfilePath(env));
      expect((e as Error).message).toContain("{brief}");
    }
  });

  test("refuses a profile that is not an object", () => {
    expect(() => readSpawnProfile(machine("[]"))).toThrow(/not an object/);
  });

  test("refuses argv that is not an array of strings", () => {
    const bad = JSON.stringify({ argv: "claude", slots: {}, grants: {} });
    expect(() => readSpawnProfile(machine(bad))).toThrow(/argv is not an array/);
  });

  test("refuses a slot with no placeholder in argv", () => {
    const bad = JSON.stringify({
      argv: ["claude", "{brief}", "{model}"],
      slots: { tools: { join: "," } },
      grants: {},
    });
    expect(() => readSpawnProfile(machine(bad))).toThrow(/tools has no \{tools\} placeholder/);
  });

  test("refuses a capability that is no capability", () => {
    const bad = JSON.stringify({
      argv: ["claude", "{brief}", "{model}", "{tools}"],
      slots: { tools: { join: "," } },
      grants: { "delete-everything": { tools: ["rm"] } },
    });
    expect(() => readSpawnProfile(machine(bad))).toThrow(/delete-everything, which is no capability/);
  });

  test("refuses a capability granting into a slot that does not exist", () => {
    const bad = JSON.stringify({
      argv: ["claude", "{brief}", "{model}", "{tools}"],
      slots: { tools: { join: "," } },
      grants: { "read-files": { sandbox: ["Read"] } },
    });
    expect(() => readSpawnProfile(machine(bad))).toThrow(/sandbox, which slots does not define/);
  });

  test("refuses a placeholder that names no model, brief or declared slot", () => {
    const bad = JSON.stringify({
      argv: ["claude", "{brief}", "{model}", "{tools}", "{tols}"],
      slots: { tools: { join: "," } },
      grants: {},
    });
    expect(() => readSpawnProfile(machine(bad))).toThrow(/\{tols\}, which is neither/);
  });

  test("refuses a key named twice, which JSON would silently resolve", () => {
    const bad =
      '{ "argv": ["claude", "{brief}", "{model}", "{tools}"], "slots": { "tools": { "join": "," }, "tools": { "join": ";" } }, "grants": {} }';
    expect(() => readSpawnProfile(machine(bad))).toThrow(/names slots.tools twice/);
  });
});

describe("building argv from a profile", () => {
  test("joins every granted value for a slot with its separator, in request order", () => {
    const profile = readSpawnProfile(machine(CLAUDE_PROFILE));

    const argv = spawnArgv(profile, {
      model: "large",
      brief: "read the diff",
      capabilities: ["read-files", "read-history", "ask-dim"],
    });

    expect(argv).toEqual([
      "claude",
      "-p",
      "read the diff",
      "--model",
      "large",
      "--allowedTools",
      "Read,Grep,Glob,Bash(git diff:*),Bash(dim q:*)",
    ]);
  });

  test("appends a later capability's tools rather than reordering earlier ones", () => {
    const profile = readSpawnProfile(machine(CLAUDE_PROFILE));

    const argv = spawnArgv(profile, {
      model: "large",
      brief: "review the diff",
      capabilities: ["read-files", "read-history", "ask-dim", "raise-finding"],
    });

    expect(argv[argv.length - 1]).toBe(
      "Read,Grep,Glob,Bash(git diff:*),Bash(dim q:*),Bash(dim order finding:*)",
    );
  });

  test("deduplicates a value granted by more than one capability", () => {
    const profile: SpawnProfile = {
      argv: ["claude", "{tools}"],
      slots: { tools: { join: "," } },
      grants: {
        "read-files": { tools: ["Read"] },
        "read-history": { tools: ["Read"] },
      },
    };

    const argv = spawnArgv(profile, { model: "m", brief: "b", capabilities: ["read-files", "read-history"] });

    expect(argv).toEqual(["claude", "Read"]);
  });

  test("refuses a capability the profile grants nothing for", () => {
    const profile = readSpawnProfile(machine(CLAUDE_PROFILE));

    try {
      spawnArgv(profile, { model: "large", brief: "edit something", capabilities: ["edit-files"] });
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SpawnProfileError);
      expect((e as SpawnProfileError).kind).toBe("ungranted");
      expect((e as Error).message).toContain("edit-files");
    }
  });
});
