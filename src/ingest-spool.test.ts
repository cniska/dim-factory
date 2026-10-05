import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
import { closeDb, openDb } from "./db";
import { harnessesOnPath, scratchEnv, writeClaudeTranscript } from "./fixtures.test-support";
import { HARNESSES, type HarnessName } from "./harness-contract";
import {
  dimPath,
  editCommand,
  HOOK_CONTRACT_VERSION,
  HookConfig,
  hookCommand,
  hookContractVersion,
  startCommand,
  wantedHooks,
} from "./hook-commands";
import { installHooks, planHooks } from "./hooks";
import { drainSpool, ensureSpoolDirs, toolSpoolDir } from "./ingest-spool";
import { rebuild, sync } from "./ingest-sync";
import { dbPath, type Env, resolveHomeDir, spoolDir } from "./paths";

const SESSION = "11111111-2222-3333-4444-555555555555";
const HOOK_UNWRITABLE = expect.objectContaining({ code: "config_unwritable" });
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-spool-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

describe("spool", () => {
  test("records the harness pid from a SessionStart spool filename", () => {
    const env = scratchEnv(newRoot());
    ensureSpoolDirs(env);
    writeFileSync(
      join(toolSpoolDir("claude", env), "1789000000000000000-4242-7319-.json"),
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

  test("a SessionStart shell hook writes its live parent pid", () => {
    const env = scratchEnv(newRoot());
    ensureSpoolDirs(env);
    execFileSync("/bin/sh", ["-c", hookCommand("claude", env, "SessionStart")], {
      input: JSON.stringify(startEvent(SESSION, "startup")),
      env: { ...process.env, DIM_WORKER_NAME: "" },
    });
    const db = openDb(dbPath(env));
    try {
      expect(drainSpool(db, env)).toMatchObject({ applied: 1, unreadable: 0 });
      expect(db.prepare("SELECT harness_pid FROM hook_event WHERE session_id = ?").get(SESSION)).toEqual({
        harness_pid: process.pid,
      });
    } finally {
      closeDb(db);
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
      expect(db.prepare("SELECT ts FROM hook_event ORDER BY ts").all()).toEqual([
        { ts: "2026-09-10T00:26:40.000Z" },
        { ts: "2026-09-10T00:26:40.400Z" },
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

  test("applies a payload whose reason and cwd are null", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    spool(env, "claude", "1789000000000000000", { ...endEvent(SESSION, "other"), cwd: null, reason: null });
    const db = openDb(dbPath(env));
    try {
      expect(drainSpool(db, env)).toMatchObject({ applied: 1, unreadable: 0 });
    } finally {
      closeDb(db);
    }
  });

  test("sets aside a payload whose read field has the wrong type", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const path = spool(env, "claude", "1789000000000000000", { ...endEvent(SESSION, "other"), cwd: 42 });
    const db = openDb(dbPath(env));
    try {
      expect(drainSpool(db, env)).toMatchObject({ applied: 0, unreadable: 1 });
      expect(existsSync(path)).toBe(false);
      expect(db.prepare("SELECT count(*) AS n FROM hook_event").get()).toEqual({ n: 0 });
    } finally {
      closeDb(db);
    }
  });

  test("sets aside a file it cannot place rather than dropping it", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const path = spool(env, "claude", "1789000000000000000", { hook_event_name: "SessionEnd" });
    writeFileSync(join(toolSpoolDir("claude", env), "1789000000000000001-1.json"), "{not json");
    const db = openDb(dbPath(env));
    try {
      expect(drainSpool(db, env)).toMatchObject({ applied: 0, unreadable: 2 });
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(join(spoolDir(env), "unreadable")).length).toBe(2);
    } finally {
      closeDb(db);
    }
  });

  test("sets aside a post-tool event, which the record does not keep", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    spool(env, "claude", "1789000000000000000", {
      session_id: SESSION,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      cwd: "/Users/x/code/demo",
    });
    const db = openDb(dbPath(env));
    try {
      expect(drainSpool(db, env)).toMatchObject({ applied: 0, unreadable: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM hook_event").get()).toEqual({ n: 0 });
      expect(() =>
        db.run(
          "INSERT INTO hook_event (tool, session_id, event, ts) VALUES ('claude', 's', 'post_tool_use', '2026-01-01T00:00:00Z')",
        ),
      ).toThrow();
    } finally {
      closeDb(db);
    }
  });
});

describe("installHooks", () => {
  function configs(env: Env): { claude: string } {
    return { claude: join(resolveHomeDir(env), ".claude", "settings.json") };
  }
  function hookEnv(dir: string, onPath: readonly string[] = ["claude"]): Env {
    return {
      HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      PATH: harnessesOnPath(dir, onPath),
    };
  }

  test("writes no hook while Claude Code is not installed", () => {
    const env = hookEnv(newRoot(), []);

    installHooks(env);

    expect(existsSync(configs(env).claude)).toBe(false);
    expect(planHooks(env)).toEqual([]);
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
    expect(after.hooks.SessionStart[1].hooks[0].command).toBe(startCommand());
    expect(startCommand()).not.toContain("--tool");
    expect(after.hooks.PostToolUse).toHaveLength(1);
    expect(after.hooks.PostToolUse[0].hooks[0].command).toBe(editCommand());
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
    expect(after.hooks.PostToolUse).toHaveLength(2);
    expect(after.hooks.SessionEnd).toHaveLength(2);
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

    expect(() => installHooks(env)).toThrow(HOOK_UNWRITABLE);
    expect(readFileSync(paths.claude, "utf8")).toBe(before);
    expect(existsSync(`${paths.claude}.dim-backup`)).toBe(false);
  });

  test("installing twice adds one hook", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    installHooks(env);
    const first = readFileSync(configs(env).claude, "utf8");
    expect(installHooks(env)).toMatchObject({ written: [], alreadyPresent: 4, retired: 0 });
    expect(readFileSync(configs(env).claude, "utf8")).toBe(first);
    expect(planHooks(env).every((p) => p.state === "installed")).toBe(true);
  });

  test("no installed hook can fail a session, whether dim fails, dies, is missing or has no spool", async () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    installHooks(env);
    const config = HookConfig.parse(JSON.parse(readFileSync(HARNESSES.claude.hookConfig(env), "utf8")));
    const installed = Object.values(config.hooks ?? {}).flatMap((entries) =>
      entries.flatMap((entry) =>
        (entry.hooks ?? []).flatMap((hook) =>
          hook.command === undefined ? [] : [{ command: hook.command }],
        ),
      ),
    );
    expect(installed.map(({ command }) => command).sort()).toEqual(
      wantedHooks("claude", env)
        .map((h) => h.command)
        .sort(),
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
      const runs = await Promise.all(
        installed.map(async ({ command }) => {
          const run = Bun.spawn(["/bin/sh", "-c", throughShim(command)], {
            stdin: new TextEncoder().encode(JSON.stringify(endEvent(SESSION, "exit"))),
            stdout: "ignore",
            stderr: "ignore",
            env: { PATH: `${bin}:/usr/bin:/bin` },
          });
          return { command, state, status: await run.exited };
        }),
      );
      for (const run of runs) expect(run).toEqual({ ...run, status: 0 });
    }
  });

  test("SessionStart names the harness parent pid in the spool file", () => {
    const env = hookEnv(newRoot());
    expect(hookCommand("claude", env, "SessionStart")).toMatch(/-\$\$-\$PPID-\$\{DIM_WORKER_NAME:-\}\.json/);
  });

  test("a version 2 SessionStart spool hook is stale", () => {
    const dir = newRoot();
    const env = hookEnv(dir);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const old = hookCommand("claude", env).replace(`dim-hook:${HOOK_CONTRACT_VERSION}`, "dim-hook:2");
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
        hooks: { SessionEnd: [{ hooks: [{ type: "command", command: unmarked }] }] },
      }),
    );

    const plan = planHooks(env).find((p) => p.tool === "claude" && p.event === "SessionEnd");
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
    const matchers = (config: { hooks: Record<string, { matcher?: string }[]> }) =>
      Object.values(config.hooks)
        .flat()
        .map((entry) => entry.matcher ?? null);
    expect(claude.hooks.PostToolUse).toContainEqual({
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: editCommand() }],
    });
    expect(matchers(claude).filter((m) => m !== null)).toHaveLength(1);
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
        hooks: { PostToolUse: [{ hooks: [{ type: "command", command: editCommand(), timeout: 40 }] }] },
      }),
    );

    expect(planHooks(env).find((p) => p.event === "PostToolUse" && p.kind === "edit")).toMatchObject({
      state: "stale",
      outdated: "matcher",
    });
    expect(installHooks(env)).toMatchObject({ refreshed: 1 });
    const after = JSON.parse(readFileSync(configs(env).claude, "utf8"));
    expect(after.hooks.PostToolUse).toEqual([
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: editCommand(), timeout: 40 }],
      },
    ]);
    expect(installHooks(env).written).toEqual([]);
  });

  test("a spool hook it once installed after every tool is removed, and the hooks around it stay", () => {
    const dir = newRoot();
    const env = hookEnv(dir, ["claude"]);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    installHooks(env);
    const installed = JSON.parse(readFileSync(configs(env).claude, "utf8"));
    const spool = { type: "command", command: hookCommand("claude", env) };
    installed.hooks.PostToolUse = [
      { hooks: [spool] },
      { hooks: [{ type: "command", command: "user-formatter" }, spool] },
      ...installed.hooks.PostToolUse,
    ];
    writeFileSync(configs(env).claude, JSON.stringify(installed));

    expect(planHooks(env).filter((p) => p.state === "retired")).toHaveLength(2);
    expect(installHooks(env)).toMatchObject({ retired: 2, refreshed: 0 });
    const after = JSON.parse(readFileSync(configs(env).claude, "utf8"));
    expect(after.hooks.PostToolUse).toEqual([
      { hooks: [{ type: "command", command: "user-formatter" }] },
      { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: editCommand() }] },
    ]);
    expect(after.hooks.SessionEnd).toEqual([{ hooks: [spool] }]);
    expect(planHooks(env).every((p) => p.state === "installed")).toBe(true);
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

    expect(installHooks(env)).toMatchObject({ refreshed: 1, retired: 1 });
    const after = JSON.parse(readFileSync(configs(env).claude, "utf8"));
    expect(after.hooks.PostToolUse).toEqual([
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: editCommand() }],
      },
    ]);
    expect(installHooks(env).written).toEqual([]);
  });
});
