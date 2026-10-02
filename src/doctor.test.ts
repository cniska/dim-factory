import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Ran } from "./cli-contract";
import { closeDb, openDb } from "./db";
import { openReadOnly } from "./db-read";
import { SCHEMA_VERSION } from "./db-schema";
import { diagnose } from "./doctor";
import { doctorCommand } from "./doctor-command";
import { harnessesOnPath, scratchEnv, writeClaudeTranscript } from "./fixtures.test-support";
import { wantedHooks } from "./hook-commands";
import { installHooks } from "./hooks";
import { codexConfigPath, planCodexTrust } from "./hooks-codex-trust";
import { agentPlistPath } from "./ingest-launchd";
import { sync } from "./ingest-sync";
import { dbPath, type Env } from "./paths";
import { installSkill } from "./skill";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-doctor-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function seeded(): Env {
  const root = newRoot();
  const env = { ...scratchEnv(root), HOME: join(root, "home") };
  writeClaudeTranscript(env, "-Users-x-code-demo", "11111111-2222-3333-4444-555555555555");
  const db = openDb(dbPath(env));
  sync(db, env);
  closeDb(db);
  return env;
}

function check(env: Env, name: string) {
  const db = openReadOnly(dbPath(env));
  try {
    return diagnose(db, env).find((c) => c.name === name);
  } finally {
    db.close();
  }
}

describe("doctor", () => {
  test("diagnoses a record built by another schema version rather than refusing it", () => {
    const env = seeded();
    const db = openDb(dbPath(env));
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    closeDb(db);
    const dataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
    try {
      const ran = doctorCommand.run([]);
      expect(ran).toBeInstanceOf(Ran);
      const { checks } = (ran as Ran).result as { checks: { name: string; state: string; fix?: string }[] };
      expect(checks.find((c) => c.name === "schema")).toMatchObject({ state: "fail", fix: "dim rebuild" });
    } finally {
      if (dataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = dataHome;
    }
  });

  test("warns when the sync agent still points to a previous checkout", () => {
    const env = seeded();
    const plist = agentPlistPath(env);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "<plist>previous checkout</plist>");

    expect(check(env, "agent")).toMatchObject({
      state: "warn",
      fix: "dim agent install, then reload the launchd agent",
    });
  });

  test("warns on a link to a skill that no longer ships", () => {
    const env = seeded();
    installSkill(env);
    expect(check(env, "skill")?.state).toBe("ok");

    const stale = join(env.HOME as string, ".codex", "skills", "dim-retired");
    symlinkSync(join(dirname(import.meta.dir), "skills", "dim-retired"), stale);
    const retired = check(env, "skill");
    expect(retired?.state).toBe("warn");
    expect(retired?.detail).toContain(stale);
    expect(retired?.fix).toBe("dim skills install");
  });

  test("fails when retention is unset, because that deletes the sources", () => {
    const env = seeded();
    const claudeDir = join(env.HOME as string, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({}));
    const unset = check(env, "retention");
    expect(unset?.state).toBe("fail");
    expect(unset?.detail).toContain("30 days");

    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 3650 }));
    expect(check(env, "retention")?.state).toBe("ok");

    writeFileSync(join(claudeDir, "settings.json"), '{\n  // kept forever\n  "cleanupPeriodDays": 3650\n}\n');
    expect(check(env, "retention")?.state).toBe("ok");
  });

  test("fails the hooks while none are installed, and does not yet expect end reasons", () => {
    const env = seeded();
    expect(check(env, "hooks")?.state).toBe("fail");
    expect(check(env, "end reasons")).toMatchObject({
      state: "warn",
      detail: "not expected yet; the hooks are not installed",
    });
  });

  test("fails when hooks are installed but have never fired, until one fires", () => {
    const env = seeded();
    installHooks(env);
    expect(check(env, "hooks")?.state).toBe("ok");
    expect(check(env, "end reasons")).toMatchObject({
      state: "fail",
      detail: "the hooks are installed but have never written an event",
    });

    const sessionEnd = wantedHooks("claude", env).find((hook) => hook.event === "SessionEnd");
    execFileSync("/bin/sh", ["-c", sessionEnd?.command ?? "exit 1"], {
      input: JSON.stringify({
        session_id: "11111111-2222-3333-4444-555555555555",
        hook_event_name: "SessionEnd",
        reason: "exit",
        cwd: "/Users/x/code/demo",
      }),
    });
    const db = openDb(dbPath(env));
    sync(db, env);
    closeDb(db);
    expect(check(env, "end reasons")).toMatchObject({
      state: "ok",
      detail: "no session has both started and finished since the hooks went in",
    });
  });

  test("fails while a codex hook has no trust recorded for its position", () => {
    const env = seeded();
    const config = codexConfigPath(env);
    mkdirSync(dirname(config), { recursive: true });
    installHooks(env);

    const untrusted = check(env, "codex trust");
    expect(untrusted?.state).toBe("fail");
    expect(untrusted?.detail).toContain("session_start:0:0");

    const keys = planCodexTrust(env).map((t) => t.key as string);
    writeFileSync(config, keys.map((k) => `[hooks.state."${k}"]\ntrusted_hash = "sha256:abc"\n`).join("\n"));
    expect(check(env, "codex trust")?.state).toBe("ok");

    const hooksPath = join(dirname(config), "hooks.json");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as { hooks: Record<string, unknown[]> };
    hooks.hooks.SessionStart?.unshift({ hooks: [{ type: "command", command: "other-tool" }] });
    writeFileSync(hooksPath, JSON.stringify(hooks));
    expect(check(env, "codex trust")?.state).toBe("fail");
  });

  test("holds a harness that is not installed to nothing: no codex trust, no codex rules, no hooks for it", () => {
    const env = { ...seeded(), PATH: `${harnessesOnPath(newRoot(), ["claude"])}:/usr/bin:/bin` };
    installHooks(env);

    expect(check(env, "codex trust")).toMatchObject({ state: "ok", detail: "codex is not installed" });
    expect(check(env, "rules")?.state).toBe("ok");
    expect(check(env, "hooks")?.state).toBe("ok");
  });

  test("fails while a hook dim no longer wants is installed, until install removes it", () => {
    const base = seeded();
    const env = { ...base, PATH: `${harnessesOnPath(newRoot(), ["claude"])}:/usr/bin:/bin` };
    installHooks(env);
    const settings = join(base.HOME ?? "", ".claude", "settings.json");
    const config = JSON.parse(readFileSync(settings, "utf8"));
    const spool = config.hooks.SessionEnd[0];
    config.hooks.PostToolUse.unshift(spool);
    writeFileSync(settings, JSON.stringify(config));

    expect(check(env, "hooks")).toMatchObject({
      state: "fail",
      detail: expect.stringContaining("1 retired (PostToolUse: spool)"),
      fix: "dim hooks install",
    });
    installHooks(env);
    expect(check(env, "hooks")?.state).toBe("ok");
  });

  test("says no harness is installed rather than calling absent hooks installed", () => {
    const env = { ...seeded(), PATH: "/usr/bin:/bin" };
    expect(check(env, "hooks")).toMatchObject({ state: "warn" });
    expect(check(env, "hooks")?.detail).toContain("no harness is installed");
    expect(check(env, "end reasons")?.state).toBe("warn");
  });

  test("reports an unreadable codex config as one failure, keeping the other checks", () => {
    const env = seeded();
    const config = codexConfigPath(env);
    mkdirSync(dirname(config), { recursive: true });
    installHooks(env);
    writeFileSync(join(dirname(config), "hooks.json"), '{ "hooks": ');

    const db = openReadOnly(dbPath(env));
    try {
      const checks = diagnose(db, env);
      const by = (name: string) => checks.find((c) => c.name === name);
      expect(by("codex trust")?.state).toBe("fail");
      expect(by("hooks")?.state).toBe("fail");
      expect(by("end reasons")?.detail).toContain("not judged");
      expect(checks.map((c) => c.name)).toContain("schema");
    } finally {
      db.close();
    }
  });

  test("reports an unparseable codex config.toml rather than reading it as no trust", () => {
    const env = seeded();
    const config = codexConfigPath(env);
    mkdirSync(dirname(config), { recursive: true });
    installHooks(env);
    writeFileSync(config, "= 1\n");

    const trust = check(env, "codex trust");
    expect(trust?.state).toBe("fail");
    expect(trust?.detail).toContain(config);
    expect(trust?.detail).not.toContain("trusted_hash");
  });

  test("reports every check with something a reader can act on", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const checks = diagnose(db, env);
      expect(checks.length).toBeGreaterThan(5);
      for (const c of checks) {
        expect(c.detail.length, `${c.name} has no detail`).toBeGreaterThan(0);
        if (c.state === "fail") expect(c.fix, `${c.name} fails with no fix`).toBeTruthy();
      }
    } finally {
      db.close();
    }
  });
});
