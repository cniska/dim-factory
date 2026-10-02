import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
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
import { harnessesOnPath, scratchEnv, writeClaudeTranscript } from "./fixtures.test-support";
import type { HarnessName } from "./harness-name";
import {
  dimPath,
  editCommand,
  HOOK_CONTRACT_VERSION,
  hookCommand,
  hookContractVersion,
  startCommand,
  wantedHooks,
} from "./hook-commands";
import { hookConfigPath, installHooks, planHooks } from "./hooks";
import { drainSpool, ensureSpoolDirs, toolSpoolDir } from "./ingest-spool";
import { rebuild, sync } from "./ingest-sync";
import { dbPath, type Env, resolveHomeDir, spoolDir } from "./paths";

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

function spool(env: Env, tool: HarnessName, nanos: string, payload: unknown): string {
  ensureSpoolDirs(env);
  const path = join(toolSpoolDir(tool, env), `${nanos}-4242-.json`);
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
  test("records the harness pid from a SessionStart spool filename", () => {
    const env = scratchEnv(newRoot());
    ensureSpoolDirs(env);
    writeFileSync(
      join(toolSpoolDir("codex", env), "1789000000000000000-4242-7319-.json"),
      JSON.stringify(startEvent(SESSION, "startup")),
    );
    const db = openDb(dbPath(env));
    try {
      expect(drainSpool(db, env)).toMatchObject({ applied: 1, unreadable: 0 });
      expect(db.prepare("SELECT harness_pid FROM hook_event").get()).toEqual({ harness_pid: 7319 });
    } finally {
      closeDb(db);
    }
  });

  test("a SessionStart shell hook writes its live parent pid for each harness", () => {
    const env = scratchEnv(newRoot());
    ensureSpoolDirs(env);
    for (const tool of ["claude", "codex"] as const) {
      execFileSync("/bin/sh", ["-c", hookCommand(tool, env, "SessionStart")], {
        input: JSON.stringify(startEvent(`${SESSION}-${tool}`, "startup")),
        env: { ...process.env, DIM_WORKER_NAME: "" },
      });
      const db = openDb(dbPath(env));
      try {
        expect(drainSpool(db, env)).toMatchObject({ applied: 1, unreadable: 0 });
        expect(
          db.prepare("SELECT harness_pid FROM hook_event WHERE session_id = ?").get(`${SESSION}-${tool}`),
        ).toEqual({ harness_pid: process.pid });
      } finally {
        closeDb(db);
      }
    }
  });

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

  test("keeps a session that was resumed after it ended open", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    spool(env, "claude", "1789000000000000000", endEvent(SESSION, "other"));
    spool(env, "claude", "1789000001000000000", startEvent(SESSION, "resume"));
    const db = openDb(dbPath(env));
    try {
      sync(db, env);
      expect(db.prepare(`SELECT ended_at, end_reason FROM session WHERE id = '${SESSION}'`).get()).toEqual({
        ended_at: null,
        end_reason: null,
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
    ensureSpoolDirs(env);
    writeFileSync(
      join(toolSpoolDir("claude", env), "1789000000000000001-4242-7319-.json"),
      JSON.stringify(startEvent(SESSION, "startup")),
    );
    const db = openDb(dbPath(env));
    try {
      sync(db, env);
      rebuild(db, env);
      expect(db.prepare("SELECT harness_pid FROM hook_event WHERE event = 'session_start'").get()).toEqual({
        harness_pid: 7319,
      });
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

  test("a drain that fails partway keeps every spool file for the next one", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const first = spool(env, "claude", "1789000000000000000", endEvent(SESSION, "prompt_input_exit"));
    const second = spool(env, "claude", "1789000000000000001", endEvent("refused", "other"));
    writeFileSync(join(toolSpoolDir("claude", env), "1789000000000000000-1.json"), "{not json");
    const db = openDb(dbPath(env));
    try {
      db.run(
        `CREATE TEMP TRIGGER refuse BEFORE INSERT ON hook_event
         WHEN NEW.session_id = 'refused' BEGIN SELECT RAISE(ABORT, 'refused'); END`,
      );
      expect(() => drainSpool(db, env)).toThrow("refused");
      expect(db.prepare("SELECT count(*) AS n FROM hook_event").get()).toEqual({ n: 0 });
      expect([existsSync(first), existsSync(second)]).toEqual([true, true]);
      expect(readdirSync(join(spoolDir(env), "unreadable"))).toEqual(["1789000000000000000-1.json"]);

      db.run("DROP TRIGGER refuse");
      expect(drainSpool(db, env)).toMatchObject({ applied: 2, unreadable: 0 });
      expect([existsSync(first), existsSync(second)]).toEqual([false, false]);
    } finally {
      closeDb(db);
    }
  });

  test("sets aside a file it cannot place rather than dropping it", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const path = spool(env, "claude", "1789000000000000000", { hook_event_name: "SessionEnd" });
    writeFileSync(join(toolSpoolDir("codex", env), "1789000000000000001-1.json"), "{not json");
    const db = openDb(dbPath(env));
    try {
      expect(drainSpool(db, env)).toMatchObject({ applied: 0, unreadable: 2 });
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(join(spoolDir(env), "unreadable")).length).toBe(2);
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
    return resolveHomeDir(env);
  }
  function hookEnv(dir: string, onPath: readonly string[] = ["claude", "codex"]): Env {
    return {
      HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      PATH: harnessesOnPath(dir, onPath),
    };
  }

  test("writes hooks only for the harnesses installed on this machine", () => {
    const dir = newRoot();
    const env = hookEnv(dir, ["claude"]);

    installHooks(env);

    expect(existsSync(configs(env).claude)).toBe(true);
    expect(existsSync(configs(env).codex)).toBe(false);
    expect(new Set(planHooks(env).map((plan) => plan.tool))).toEqual(new Set(["claude"]));
  });

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
    expect(after.hooks.SessionStart).toHaveLength(2);
    expect(after.hooks.SessionStart[0].hooks[0].command).toBe(hookCommand("claude", env, "SessionStart"));
    expect(after.hooks.SessionStart[1].hooks[0].command).toBe(startCommand("claude"));
    expect(after.hooks.PostToolUse).toHaveLength(2);
    expect(after.hooks.PostToolUse[0].hooks[0].command).toBe(hookCommand("claude", env));
    expect(after.hooks.PostToolUse[1].hooks[0].command).toBe(editCommand());
    expect(readFileSync(`${paths.claude}.dim-backup`, "utf8")).toContain("existing-notifier");
  });

  test("a user's hook that mentions a dim command is not replaced", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    const paths = configs(env);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      paths.claude,
      JSON.stringify({
        hooks: {
          PostToolUse: [{ hooks: [{ type: "command", command: "echo format-edit" }] }],
          SessionEnd: [{ hooks: [{ type: "command", command: `echo ${toolSpoolDir("claude", env)}` }] }],
        },
      }),
    );

    installHooks(env);

    const after = JSON.parse(readFileSync(paths.claude, "utf8"));
    expect(after.hooks.PostToolUse[0].hooks[0].command).toBe("echo format-edit");
    expect(after.hooks.SessionEnd[0].hooks[0].command).toBe(`echo ${toolSpoolDir("claude", env)}`);
    expect(after.hooks.PostToolUse).toHaveLength(3);
    expect(after.hooks.SessionEnd).toHaveLength(2);
  });

  test("an older spool hook is refreshed in place", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    const paths = configs(env);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const old = hookCommand("claude", env)
      .replace(/-\$\$-\$\{DIM_WORKER_NAME:-\}\.json/, () => "-$$.json")
      .replace(`dim-hook:${HOOK_CONTRACT_VERSION}`, "dim-hook:1");
    writeFileSync(
      paths.claude,
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: old }] }] } }),
    );

    expect(
      planHooks(env).find((plan) => plan.tool === "claude" && plan.event === "SessionEnd"),
    ).toMatchObject({
      state: "stale",
      installedVersion: 1,
    });
    expect(installHooks(env).refreshed).toBe(1);
    const after = JSON.parse(readFileSync(paths.claude, "utf8"));
    expect(after.hooks.SessionEnd).toHaveLength(1);
    expect(after.hooks.SessionEnd[0].hooks[0].command).toBe(hookCommand("claude", env));
    expect(installHooks(env).written).toEqual([]);
  });

  test("an unmarked original spool hook is refreshed in place", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    const paths = configs(env);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const old = hookCommand("claude", env)
      .replace(/-\$\$-\$\{DIM_WORKER_NAME:-\}\.json/, () => "-$$.json")
      .replace(/ # dim-hook:\d+$/, "");
    writeFileSync(
      paths.claude,
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: old }] }] } }),
    );

    expect(
      planHooks(env).find((plan) => plan.tool === "claude" && plan.event === "SessionEnd"),
    ).toMatchObject({ state: "stale", installedVersion: null });
    expect(installHooks(env).refreshed).toBe(1);
    const after = JSON.parse(readFileSync(paths.claude, "utf8"));
    expect(after.hooks.SessionEnd).toHaveLength(1);
    expect(after.hooks.SessionEnd[0].hooks[0].command).toBe(hookCommand("claude", env));
  });

  test("a moved spool directory refreshes the installed hook", () => {
    const dir = newRoot();
    const oldEnv = { ...hookEnv(dir), XDG_DATA_HOME: join(dir, "old-data") };
    const newEnv = { ...oldEnv, XDG_DATA_HOME: join(dir, "new-data") };
    installHooks(oldEnv);

    expect(
      planHooks(newEnv).find((plan) => plan.tool === "claude" && plan.event === "SessionEnd")?.state,
    ).toBe("stale");
    installHooks(newEnv);
    const after = JSON.parse(readFileSync(configs(newEnv).claude, "utf8"));
    expect(after.hooks.SessionEnd).toHaveLength(1);
    expect(after.hooks.SessionEnd[0].hooks[0].command).toBe(hookCommand("claude", newEnv));
    expect(installHooks(newEnv).written).toEqual([]);
  });

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
    expect(installHooks(env)).toMatchObject({ written: [], alreadyPresent: 10 });
    expect(readFileSync(configs(env).claude, "utf8")).toBe(first);
    expect(planHooks(env).every((p) => p.state === "installed")).toBe(true);
  });

  test("no installed hook can fail a session, whether dim fails, dies, is missing or has no spool", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    installHooks(env);
    const installed = (["claude", "codex"] as const).flatMap((tool) => {
      const config = JSON.parse(readFileSync(hookConfigPath(tool, env), "utf8")) as {
        hooks: Record<string, { hooks: { command: string }[] }[]>;
      };
      return Object.values(config.hooks).flatMap((entries) =>
        entries.flatMap((entry) => entry.hooks.map((hook) => ({ tool, command: hook.command }))),
      );
    });
    expect(installed.map(({ command }) => command).sort()).toEqual(
      (["claude", "codex"] as const).flatMap((tool) => wantedHooks(tool, env).map((h) => h.command)).sort(),
    );

    const bin = join(dir, "dim-bin");
    const shim = join(bin, "dim");
    mkdirSync(bin);
    const installedDim = `${dimPath()} `;
    const throughShim = (command: string) =>
      command.startsWith(installedDim) ? `${shim} ${command.slice(installedDim.length)}` : command;
    const dims: [string, string | null][] = [
      ["fails", "#!/bin/sh\necho out\necho err >&2\nexit 1\n"],
      ["dies", "#!/bin/sh\nkill -9 $$\n"],
      ["is missing", null],
    ];
    rmSync(spoolDir(env), { recursive: true, force: true });
    for (const [state, body] of dims) {
      rmSync(shim, { force: true });
      if (body !== null) writeFileSync(shim, body, { mode: 0o755 });
      for (const { tool, command } of installed) {
        const run = spawnSync("/bin/sh", ["-c", throughShim(command)], {
          input: JSON.stringify(endEvent(SESSION, "exit")),
          env: { PATH: `${bin}:/usr/bin:/bin` },
        });
        expect({ tool, command, state, status: run.status }).toEqual({ tool, command, state, status: 0 });
      }
    }
  });

  test("SessionStart names the harness parent pid in the spool file", () => {
    const env = hookEnv(newRoot());
    for (const tool of ["claude", "codex"] as const) {
      expect(hookCommand(tool, env, "SessionStart")).toMatch(/-\$\$-\$PPID-\$\{DIM_WORKER_NAME:-\}\.json/);
    }
  });

  test("a version 2 SessionStart spool hook is stale", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const old = hookCommand("claude", env).replace("dim-hook:3", "dim-hook:2");
    writeFileSync(
      configs(env).claude,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: old }] }] } }),
    );
    expect(
      planHooks(env).find((plan) => plan.tool === "claude" && plan.event === "SessionStart"),
    ).toMatchObject({
      state: "stale",
      installedVersion: 2,
    });
  });

  test("every command it installs says which contract wrote it", () => {
    const env = hookEnv(newRoot());
    for (const { command } of wantedHooks("claude", env)) {
      expect(hookContractVersion(command)).toBe(HOOK_CONTRACT_VERSION);
    }
  });

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

  test("the format hook runs only after an edit tool, and every other hook after anything", () => {
    const env = hookEnv(newRoot());
    installHooks(env);

    const claude = JSON.parse(readFileSync(configs(env).claude, "utf8"));
    const codex = JSON.parse(readFileSync(configs(env).codex, "utf8"));
    const matchers = (config: { hooks: Record<string, { matcher?: string }[]> }) =>
      Object.values(config.hooks)
        .flat()
        .map((entry) => entry.matcher ?? null);
    expect(claude.hooks.PostToolUse).toContainEqual({
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: editCommand() }],
    });
    expect(codex.hooks.PostToolUse).toContainEqual({
      matcher: "apply_patch",
      hooks: [{ type: "command", command: editCommand() }],
    });
    expect(matchers(claude).filter((m) => m !== null)).toHaveLength(1);
    expect(matchers(codex).filter((m) => m !== null)).toHaveLength(1);
    expect(planHooks(env).every((p) => p.state === "installed")).toBe(true);
    expect(installHooks(env).written).toEqual([]);
  });

  test("a format hook that runs after every tool is narrowed in place", () => {
    const dir = newRoot();
    const env = hookEnv(dir, ["claude"]);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      configs(env).claude,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { hooks: [{ type: "command", command: hookCommand("claude", env) }] },
            { hooks: [{ type: "command", command: editCommand(), timeout: 40 }] },
          ],
        },
      }),
    );

    expect(planHooks(env).find((p) => p.event === "PostToolUse" && p.kind === "edit")).toMatchObject({
      state: "stale",
      outdated: "matcher",
    });
    expect(installHooks(env)).toMatchObject({ refreshed: 1 });
    const after = JSON.parse(readFileSync(configs(env).claude, "utf8"));
    expect(after.hooks.PostToolUse).toEqual([
      { hooks: [{ type: "command", command: hookCommand("claude", env) }] },
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: editCommand(), timeout: 40 }],
      },
    ]);
    expect(installHooks(env).written).toEqual([]);
  });

  test("a format hook sharing an entry with the spool hook moves to its own", () => {
    const dir = newRoot();
    const env = hookEnv(dir, ["claude"]);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const oldSpool = `${hookCommand("claude", env).replace(/ # dim-hook:\d+$/, "")} # dim-hook:0`;
    writeFileSync(
      configs(env).claude,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [
                { type: "command", command: editCommand() },
                { type: "command", command: oldSpool },
              ],
            },
          ],
        },
      }),
    );

    expect(installHooks(env)).toMatchObject({ refreshed: 2 });
    const after = JSON.parse(readFileSync(configs(env).claude, "utf8"));
    expect(after.hooks.PostToolUse).toEqual([
      { hooks: [{ type: "command", command: hookCommand("claude", env) }] },
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: editCommand() }],
      },
    ]);
    expect(installHooks(env).written).toEqual([]);
  });
});
