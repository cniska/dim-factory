import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { diagnose } from "./doctor";
import { scratchEnv, writeClaudeTranscript } from "./fixtures.test-support";
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

  test("fails when hooks are installed but have never fired", () => {
    const env = seeded();
    // No hooks in this scratch home, so the check must say it is not expected
    // yet rather than reporting a failure the owner cannot act on.
    expect(check(env, "end reasons")?.state).toBe("warn");
    expect(check(env, "hooks")?.state).toBe("fail");
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
