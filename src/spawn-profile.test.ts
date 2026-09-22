import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
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
    "bootstrap-worker": { tools: ["Bash(dim worker bootstrap:*)"] },
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

// The files that read a harness's own leavings, each for the reason stated: whose format is
// being read is the whole of what they do, so naming the harness there is the job rather than
// a shortcut around this order's reader. Written out rather than derived from a pattern, the
// same argument src/routing.test.ts makes for writing its tier table out: a glob a file could
// be added to for the sole purpose of turning this test green would ratify the very thing it
// exists to catch.
const READING_SET: { file: string; reason: string }[] = [
  { file: "src/tools.ts", reason: "declares the Tool vocabulary itself" },
  { file: "src/hooks.ts", reason: "resolves which harness's own hook config to write" },
  { file: "src/walk.ts", reason: "resolves which harness's own rules file to read" },
  { file: "src/wake.ts", reason: "branches on which harness woke the hook" },
  { file: "src/history.ts", reason: "loads each harness's own history file" },
  { file: "src/claude-source.ts", reason: "tags a session read from Claude's own transcripts" },
  { file: "src/codex-source.ts", reason: "tags a session read from Codex's own transcripts" },
  { file: "src/codex-harness.ts", reason: "translates Codex's own process stream" },
  { file: "src/codex-trust.ts", reason: "resolves Codex's own trust config path" },
  { file: "src/cli.ts", reason: "dim wake defaults its --tool flag to claude" },
  { file: "src/queries.ts", reason: "reports counts by which harness recorded the session" },
];

const HARNESS_LITERAL = /"claude"|'claude'|"codex"|'codex'/;

describe("no harness name reaches source outside the files that read one", () => {
  test("names none in a file that is not on the reading set", () => {
    const root = join(import.meta.dir, "..");
    const allowed = new Set(READING_SET.map((r) => r.file));
    const offenders: string[] = [];
    for (const pattern of ["src/**/*.ts", "src/**/*.tsx", "skills/**/*.md"]) {
      for (const file of new Glob(pattern).scanSync(root)) {
        if (file.includes(".test.") || file.includes(".test-support.")) continue;
        if (allowed.has(file)) continue;
        if (HARNESS_LITERAL.test(readFileSync(join(root, file), "utf8"))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  // A file kept on the list after its own literal was removed would read as permission for
  // the next one, so the list is checked against the source it claims rather than trusted.
  test("names one in every file the reading set excuses", () => {
    const root = join(import.meta.dir, "..");
    const stale = READING_SET.filter(
      (r) => !HARNESS_LITERAL.test(readFileSync(join(root, r.file), "utf8")),
    ).map((r) => r.file);
    expect(stale).toEqual([]);
  });
});
