import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexConfigPath, planCodexTrust } from "./codex-trust";
import { closeDb, openDb } from "./db";
import { diagnose } from "./doctor";
import { scratchEnv, writeClaudeTranscript } from "./fixtures.test-support";
import { installHooks } from "./hooks";
import { dbPath, type Env } from "./paths";
import { openReadOnly } from "./read-db";
import { sync } from "./sync";

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
  // HOME too, not just the DIM_* roots: doctor reads the tools' own config, and
  // a test that leaves it unset would diagnose the real machine.
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
  test("fails when retention is unset, because that deletes the sources", () => {
    const env = seeded();
    const claudeDir = join(env.HOME as string, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({}));
    const unset = check(env, "retention");
    expect(unset?.state).toBe("fail");
    expect(unset?.detail).toContain("30 days");

    // Removing the setting must flip the check, or it is not holding anything.
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 3650 }));
    expect(check(env, "retention")?.state).toBe("ok");
  });

  test("warns until one commit gate covers every repo", () => {
    const env = seeded();
    const missing = check(env, "commit gate");
    expect(missing?.state).toBe("warn");
    expect(missing?.fix).toContain("install-commit-gate");

    // Writing the hooks must flip it, or the check is reporting a constant. A
    // gate missing one hook is a rule back to being asked, so it still warns and
    // names which one.
    const hooks = join(env.HOME as string, ".config", "dim", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "commit-msg"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(hooks, "pre-commit"), "#!/usr/bin/env bash\nexit 0\n");
    const partial = check(env, "commit gate");
    expect(partial?.state).toBe("warn");
    expect(partial?.detail).toContain("pre-push");

    writeFileSync(join(hooks, "pre-push"), "#!/usr/bin/env bash\nexit 0\n");
    expect(check(env, "commit gate")?.state).toBe("ok");
  });

  test("fails when hooks are installed but have never fired", () => {
    const env = seeded();
    // No hooks in this scratch home, so the check must say it is not expected
    // yet rather than reporting a failure the owner cannot act on.
    expect(check(env, "end reasons")?.state).toBe("warn");
    expect(check(env, "hooks")?.state).toBe("fail");
  });

  // Codex writes the hook the moment install-hooks does and runs it only once
  // config.toml trusts its position, so "installed" and "running" are different
  // facts and only this check reads the second one.
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

    // An entry inserted ahead of dim's shifts every index after it, and the
    // trust recorded against the old position no longer names dim's hook.
    const hooksPath = join(dirname(config), "hooks.json");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as { hooks: Record<string, unknown[]> };
    hooks.hooks.SessionStart?.unshift({ hooks: [{ type: "command", command: "other-tool" }] });
    writeFileSync(hooksPath, JSON.stringify(hooks));
    expect(check(env, "codex trust")?.state).toBe("fail");
  });

  test("reports every check with something a reader can act on", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const checks = diagnose(db, env);
      expect(checks.length).toBeGreaterThan(5);
      for (const c of checks) {
        expect(c.detail.length, `${c.name} has no detail`).toBeGreaterThan(0);
        // A failure a reader cannot act on is a complaint, not a diagnosis.
        if (c.state === "fail") expect(c.fix, `${c.name} fails with no fix`).toBeTruthy();
      }
    } finally {
      db.close();
    }
  });
});
