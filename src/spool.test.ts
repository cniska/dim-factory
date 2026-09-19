import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./config-error";
import { closeDb, openDb } from "./db";
import { scratchEnv, writeClaudeTranscript } from "./fixtures.test-support";
import {
  HOOK_CONTRACT_VERSION,
  hookCommand,
  hookContractVersion,
  installHooks,
  planHooks,
  wakeCommand,
  wantedHooks,
} from "./hooks";
import { dbPath, type Env } from "./paths";
import { drainSpool, ensureSpoolDirs, toolSpoolDir } from "./spool";
import { rebuild, sync } from "./sync";
import type { Tool } from "./tools";

const SESSION = "11111111-2222-3333-4444-555555555555";
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-spool-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** Mimic the hook: one JSON file named with nanoseconds and a pid. */
function spool(env: Env, tool: Tool, nanos: string, payload: unknown): string {
  ensureSpoolDirs(env);
  const path = join(toolSpoolDir(tool, env), `${nanos}-4242.json`);
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

function endEvent(sessionId: string, reason: string) {
  return { session_id: sessionId, hook_event_name: "SessionEnd", reason, cwd: "/Users/x/code/demo" };
}

function startEvent(sessionId: string, source: string) {
  return { session_id: sessionId, hook_event_name: "SessionStart", source, cwd: "/Users/x/code/demo" };
}

function toolEvent(sessionId: string) {
  return {
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_use_id: "toolu_123",
    cwd: "/Users/x/code/demo",
  };
}

describe("spool", () => {
  test("records why a session ended, which no transcript says", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    spool(env, "claude", "1789000000000000000", endEvent(SESSION, "prompt_input_exit"));
    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).hooks).toMatchObject({ applied: 1, unreadable: 0 });
      expect(db.prepare(`SELECT ended_at, end_reason FROM session WHERE id = '${SESSION}'`).get()).toEqual({
        ended_at: "2026-09-10T00:26:40.000Z",
        end_reason: "prompt_input_exit",
      });
    } finally {
      closeDb(db);
    }
  });

  test("deletes each spooled file once it is stored", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    spool(env, "claude", "1789000000000000000", endEvent(SESSION, "clear"));
    const db = openDb(dbPath(env));
    try {
      drainSpool(db, env);
      expect(readdirSync(toolSpoolDir("claude", env))).toEqual([]);
      expect(db.prepare("SELECT count(*) AS n FROM hook_event").get()).toEqual({ n: 1 });
    } finally {
      closeDb(db);
    }
  });

  test("keeps an event whose session has no transcript yet, and places it later", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    spool(env, "claude", "1789000000000000000", endEvent(SESSION, "logout"));
    const db = openDb(dbPath(env));
    try {
      sync(db, env);
      expect(db.prepare("SELECT count(*) AS n FROM session").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM hook_event").get()).toEqual({ n: 1 });

      writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
      sync(db, env);
      expect(db.prepare(`SELECT end_reason FROM session WHERE id = '${SESSION}'`).get()).toEqual({
        end_reason: "logout",
      });
    } finally {
      closeDb(db);
    }
  });

  test("a rebuild keeps hook events, the one input with no source to re-read", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    spool(env, "claude", "1789000000000000000", endEvent(SESSION, "clear"));
    const db = openDb(dbPath(env));
    try {
      sync(db, env);
      rebuild(db, env);
      expect(db.prepare("SELECT count(*) AS n FROM hook_event").get()).toEqual({ n: 1 });
      expect(db.prepare(`SELECT end_reason FROM session WHERE id = '${SESSION}'`).get()).toEqual({
        end_reason: "clear",
      });
    } finally {
      closeDb(db);
    }
  });

  test("draining twice stores one event", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    spool(env, "claude", "1789000000000000000", endEvent(SESSION, "clear"));
    const db = openDb(dbPath(env));
    try {
      drainSpool(db, env);
      spool(env, "claude", "1789000000000000000", endEvent(SESSION, "clear"));
      expect(drainSpool(db, env)).toMatchObject({ applied: 0, duplicate: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM hook_event").get()).toEqual({ n: 1 });
    } finally {
      closeDb(db);
    }
  });

  // Two starts a fraction of a second apart are two things that happened, and
  // the spooled file is the only copy of each.
  test("keeps both events when one second holds two of them", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    spool(env, "claude", "1789000000000000000", startEvent(SESSION, "startup"));
    spool(env, "claude", "1789000000400000000", startEvent(SESSION, "compact"));
    const db = openDb(dbPath(env));
    try {
      expect(drainSpool(db, env)).toMatchObject({ applied: 2, duplicate: 0 });
      expect(db.prepare("SELECT source FROM hook_event ORDER BY ts").all()).toEqual([
        { source: "startup" },
        { source: "compact" },
      ]);
    } finally {
      closeDb(db);
    }
  });

  test("sets aside a file it cannot place rather than dropping it", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const path = spool(env, "claude", "1789000000000000000", { hook_event_name: "SessionEnd" }); // no session_id
    writeFileSync(join(toolSpoolDir("codex", env), "1789000000000000001-1.json"), "{not json");
    const db = openDb(dbPath(env));
    try {
      expect(drainSpool(db, env)).toMatchObject({ applied: 0, unreadable: 2 });
      expect(existsSync(path)).toBe(false);
      // The only copy of what the hook saw; losing it loses it for good.
      expect(readdirSync(join(root, "home", "spool", "unreadable")).length).toBe(2);
    } finally {
      closeDb(db);
    }
  });

  test("separates the two tools' events", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    spool(env, "claude", "1789000000000000000", endEvent("s-claude", "clear"));
    spool(env, "codex", "1789000000000000001", endEvent("s-codex", "other"));
    const db = openDb(dbPath(env));
    try {
      drainSpool(db, env);
      expect(db.prepare("SELECT tool, session_id FROM hook_event ORDER BY tool").all()).toEqual([
        { tool: "claude", session_id: "s-claude" },
        { tool: "codex", session_id: "s-codex" },
      ]);
    } finally {
      closeDb(db);
    }
  });

  test("stores a post-tool event for a later pass to interpret", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    spool(env, "claude", "1789000000000000000", toolEvent(SESSION));
    const db = openDb(dbPath(env));
    try {
      expect(drainSpool(db, env)).toMatchObject({ applied: 1, unreadable: 0 });
      expect(db.prepare("SELECT event, payload FROM hook_event").get()).toEqual({
        event: "post_tool_use",
        payload: JSON.stringify(toolEvent(SESSION)),
      });
    } finally {
      closeDb(db);
    }
  });
});

describe("installHooks", () => {
  function configs(env: Env): { claude: string; codex: string } {
    return {
      claude: join(root(env), ".claude", "settings.json"),
      codex: join(root(env), ".codex", "hooks.json"),
    };
  }
  function root(env: Env): string {
    return (env.DIM_CLAUDE_PROJECTS as string).replace("/.claude/projects", "");
  }
  function hookEnv(dir: string): Env {
    return {
      DIM_HOME: join(dir, "home"),
      DIM_CLAUDE_PROJECTS: join(dir, ".claude", "projects"),
      DIM_CODEX_DIR: join(dir, ".codex"),
    };
  }

  test("adds the hook to each tool without disturbing hooks already there", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    const paths = configs(env);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      paths.claude,
      JSON.stringify({
        hooks: {
          SessionEnd: [{ hooks: [{ type: "command", command: "existing-notifier" }] }],
          Stop: [{ hooks: [{ type: "command", command: "keep-me" }] }],
        },
        otherSetting: true,
      }),
    );

    installHooks(env);

    const after = JSON.parse(readFileSync(paths.claude, "utf8"));
    expect(after.otherSetting).toBe(true);
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.SessionEnd).toHaveLength(2);
    expect(after.hooks.SessionEnd[0].hooks[0].command).toBe("existing-notifier");
    expect(after.hooks.SessionEnd[1].hooks[0].command).toBe(hookCommand("claude", env));
    // Two at SessionStart: one writes the event to the spool, one answers with context.
    expect(after.hooks.SessionStart).toHaveLength(2);
    expect(after.hooks.SessionStart[0].hooks[0].command).toBe(hookCommand("claude", env));
    expect(after.hooks.SessionStart[1].hooks[0].command).toBe(wakeCommand("claude"));
    expect(after.hooks.PostToolUse).toHaveLength(1);
    expect(after.hooks.PostToolUse[0].hooks[0].command).toBe(hookCommand("claude", env));
    expect(readFileSync(`${paths.claude}.dim-backup`, "utf8")).toContain("existing-notifier");
  });

  // The file deciding whether sessions start is one a person hand-edits, so it
  // carries comments and a shape of their own that reserializing would discard.
  test("installs into a config carrying comments, keeping them", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    const paths = configs(env);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      paths.claude,
      `{
    // the notifier, do not remove
    "hooks": {
        "SessionEnd": [{ "hooks": [{ "type": "command", "command": "existing-notifier" }] }]
    }
}
`,
    );

    installHooks(env);

    const after = readFileSync(paths.claude, "utf8");
    expect(after).toContain("// the notifier, do not remove");
    expect(after).toContain('\n                "hooks": [');
    expect(planHooks(env).every((p) => p.state === "installed")).toBe(true);
  });

  // A key written twice is edited at its first copy and read at its last, so a
  // write that looks fine lands where nothing reads. Left alone it appends again
  // on every run and each run's backup overwrites the last good one.
  test("refuses to write when the hook would not land where a reader looks", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    const paths = configs(env);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const before = '{"hooks":{"SessionStart":[]},"hooks":{"SessionStart":[]}}';
    writeFileSync(paths.claude, before);

    expect(() => installHooks(env)).toThrow(ConfigError);
    expect(readFileSync(paths.claude, "utf8")).toBe(before);
    expect(existsSync(`${paths.claude}.dim-backup`)).toBe(false);
  });

  // A refusal on the second config after the first was already written would
  // leave a report nobody sees and a message that says nothing was written.
  test("writes no config when another one would be refused", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    const paths = configs(env);
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(paths.codex, '{"hooks":{"SessionStart":[]},"hooks":{"SessionStart":[]}}');

    expect(() => installHooks(env)).toThrow(ConfigError);
    expect(existsSync(paths.claude)).toBe(false);
  });

  test("installing twice adds one hook", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    installHooks(env);
    const first = readFileSync(configs(env).claude, "utf8");
    expect(installHooks(env)).toMatchObject({ written: [], alreadyPresent: 8 });
    expect(readFileSync(configs(env).claude, "utf8")).toBe(first);
    expect(planHooks(env).every((p) => p.state === "installed")).toBe(true);
  });

  // It runs before every session starts, so a missing database, an unreadable
  // one, or no `dim` at all has to end as silence rather than a failed start.
  test("the wake hook cannot fail a session either", () => {
    const command = wakeCommand("claude");
    expect(command).toMatch(/2>\/dev\/null \|\| true( # dim-hook:\d+)?$/);
    expect(command).toContain("wake --tool=claude");
  });

  test("the hook itself cannot fail a session", () => {
    const env = hookEnv(newRoot());
    // No jq, no sqlite, no network, and it always exits 0.
    const command = hookCommand("claude", env);
    expect(command).toStartWith("cat > ");
    expect(command).toMatch(/; exit 0( # dim-hook:\d+)?$/);
    expect(command).not.toContain("|");
  });

  test("every command it installs says which contract wrote it", () => {
    const env = hookEnv(newRoot());
    for (const { command } of wantedHooks("claude", env)) {
      expect(hookContractVersion(command)).toBe(HOOK_CONTRACT_VERSION);
    }
  });

  // A hook from an older contract runs on every session and records what that
  // contract recorded, so a config holding one reads as installed and collects
  // the wrong thing. Told apart from missing, it is something the plan can fix.
  test("a command from an older contract reads as stale, not as missing", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const old = `${hookCommand("claude", env).replace(/ # dim-hook:\d+$/, "")} # dim-hook:0`;
    writeFileSync(
      configs(env).claude,
      JSON.stringify({
        hooks: { SessionEnd: [{ hooks: [{ type: "command", command: old }] }] },
      }),
    );

    const plan = planHooks(env).find((p) => p.tool === "claude" && p.event === "SessionEnd");
    expect(plan).toMatchObject({ state: "stale", installedVersion: 0 });
  });

  test("a command carrying no contract at all reads as stale", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const unmarked = hookCommand("claude", env).replace(/ # dim-hook:\d+$/, "");
    writeFileSync(
      configs(env).claude,
      JSON.stringify({
        hooks: { PostToolUse: [{ hooks: [{ type: "command", command: unmarked }] }] },
      }),
    );

    const plan = planHooks(env).find((p) => p.tool === "claude" && p.event === "PostToolUse");
    expect(plan).toMatchObject({ state: "stale", installedVersion: null });
  });

  // Both would fire. The older one would go on writing whatever the bump was
  // made to stop, and nothing in the config would say which of the two did it.
  test("a stale command is written over rather than added beside", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const old = `${hookCommand("claude", env).replace(/ # dim-hook:\d+$/, "")} # dim-hook:0`;
    writeFileSync(
      configs(env).claude,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            { hooks: [{ type: "command", command: "existing-notifier" }] },
            { hooks: [{ type: "command", command: old }] },
          ],
        },
      }),
    );

    expect(installHooks(env)).toMatchObject({ refreshed: 1 });

    const after = JSON.parse(readFileSync(configs(env).claude, "utf8"));
    expect(after.hooks.SessionEnd).toHaveLength(2);
    expect(after.hooks.SessionEnd[0].hooks[0].command).toBe("existing-notifier");
    expect(after.hooks.SessionEnd[1].hooks[0].command).toBe(hookCommand("claude", env));
    expect(readFileSync(configs(env).claude, "utf8")).not.toContain("dim-hook:0");
  });
});
