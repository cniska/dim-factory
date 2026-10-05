import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { invariant } from "./assert";
import { Ran } from "./cli-contract";
import { closeDb, openDb } from "./db";
import { openReadOnly } from "./db-read";
import { SCHEMA_VERSION } from "./db-schema";
import { diagnose } from "./doctor";
import { doctorCommand } from "./doctor-command";
import { harnessesOnPath, scratchEnv, writeClaudeTranscript } from "./fixtures.test-support";
import { wantedHooks } from "./hook-commands";
import { installHooks } from "./hooks";
import { agentPlistPath } from "./ingest-launchd";
import { sync } from "./ingest-sync";
import { dbPath, type Env, resolveHomeDir } from "./paths";
import { installSkill } from "./skill";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-doctor-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

const Checks = z.object({
  checks: z.array(z.looseObject({ name: z.string(), state: z.string(), fix: z.string().optional() })),
});

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
      invariant(ran instanceof Ran, "the doctor ran");
      const { checks } = Checks.parse(ran.result);
      expect(checks.find((c) => c.name === "schema")).toMatchObject({ state: "fail", fix: "dim rebuild" });
    } finally {
      if (dataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = dataHome;
    }
  });

  test("reports a record of another version without reading tables that version may not have", () => {
    const root = newRoot();
    const env = { ...scratchEnv(root), HOME: join(root, "home") };
    mkdirSync(dirname(dbPath(env)), { recursive: true });
    const old = new Database(dbPath(env));
    old.run("CREATE TABLE schema_version (version INTEGER)");
    old.run("PRAGMA user_version = 1");
    old.close();

    const db = openReadOnly(dbPath(env), { forDiagnosis: true });
    try {
      const checks = diagnose(db, env);
      const named = (name: string) => checks.find((c) => c.name === name);
      expect(named("schema")).toMatchObject({ state: "fail", fix: "dim rebuild" });
      for (const name of ["freshness", "end reasons", "outcomes"]) {
        expect(named(name)).toMatchObject({ state: "warn", detail: expect.stringContaining("version 1") });
      }
    } finally {
      db.close();
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

    const stale = join(resolveHomeDir(env), ".claude", "skills", "dim-retired");
    symlinkSync(join(dirname(import.meta.dir), "skills", "dim-retired"), stale);
    const retired = check(env, "skill");
    expect(retired?.state).toBe("warn");
    expect(retired?.detail).toContain(stale);
    expect(retired?.fix).toBe("dim skills install");
  });

  test("fails when retention is unset, because that deletes the sources", () => {
    const env = seeded();
    const claudeDir = join(resolveHomeDir(env), ".claude");
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

  test("reports an unreadable hook config as one failure, keeping the other checks", () => {
    const env = seeded();
    installHooks(env);
    writeFileSync(join(resolveHomeDir(env), ".claude", "settings.json"), '{ "hooks": ');

    const db = openReadOnly(dbPath(env));
    try {
      const checks = diagnose(db, env);
      const by = (name: string) => checks.find((c) => c.name === name);
      expect(by("hooks")?.state).toBe("fail");
      expect(by("end reasons")?.detail).toContain("not judged");
      expect(checks.map((c) => c.name)).toContain("schema");
    } finally {
      db.close();
    }
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
