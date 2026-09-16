import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { scratchEnv, writeClaudeTranscript, writeCodexRollout } from "./fixtures.test-support";
import { dbPath, type Env } from "./paths";
import { findQuery, QUERIES } from "./queries";
import { NoDatabaseError, openReadOnly } from "./read-db";
import { renderTable } from "./render";
import { sync } from "./sync";

const SESSION = "11111111-2222-3333-4444-555555555555";
const THREAD = "01a0a651-086e-7150-8650-cef0f4025a58";
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-q-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function seeded(): Env {
  const env = scratchEnv(newRoot());
  writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
  writeCodexRollout(env, "sessions", THREAD);
  const db = openDb(dbPath(env));
  sync(db, env);
  closeDb(db);
  return env;
}

describe("read path", () => {
  test("opens the database read-only, so no query can reach hook_event with a write", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      // hook_event is the one table a rebuild cannot restore.
      expect(() => db.run("DELETE FROM hook_event")).toThrow();
      expect(() => db.run("DELETE FROM usage")).toThrow();
      expect(() => db.run("UPDATE session SET title = 'x'")).toThrow();
    } finally {
      db.close();
    }
  });

  test("says what to run when there is no database yet", () => {
    expect(() => openReadOnly(join(newRoot(), "missing.db"))).toThrow(NoDatabaseError);
  });

  test("every query states the base its numbers came from", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      for (const q of QUERIES) {
        if (q.name === "session") continue; // takes an argument, covered below
        const result = q.run(db);
        expect(result.denominator.length, `${q.name} has no denominator`).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });

  test("an empty corpus reads as no evidence, never as a zero", () => {
    const env = scratchEnv(newRoot());
    const write = openDb(dbPath(env));
    closeDb(write);
    const db = openReadOnly(dbPath(env));
    try {
      const cost = findQuery("cost")?.run(db);
      expect(cost?.rows).toEqual([]);
      expect(cost?.note).toBe("no session reported a cost");
      // Rendering an empty result must show the note, not an empty table that
      // reads as a measured zero.
      expect(renderTable(cost as never)).toContain("no session reported a cost");

      const sessions = findQuery("sessions")?.run(db);
      expect(sessions?.note).toContain("hooks are not installed");
    } finally {
      db.close();
    }
  });

  test("turns reports how many turns it could actually time", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const result = findQuery("turns")?.run(db);
      // Codex rollouts of one era carry no duration; the percentiles cover a
      // subset and the denominator has to say which.
      expect(result?.denominator).toMatch(/\d+ of \d+ turns carry a duration/);
      expect(result?.note).toContain("not measured, not zero");
    } finally {
      db.close();
    }
  });

  test("tokens refuses to add the two tools together", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const result = findQuery("tokens")?.run(db);
      const tools = new Set(result?.rows.map((r) => r[0]));
      expect(tools).toEqual(new Set(["claude", "codex"]));
      expect(result?.note).toContain("Not summed across tools");
    } finally {
      db.close();
    }
  });

  test("session resolves a prefix and says so when it matches nothing", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const found = findQuery("session")?.run(db, SESSION.slice(0, 8));
      expect(found?.denominator).toContain(SESSION);
      const facts = new Map(found?.rows.map((r) => [r[0], r[1]]));
      expect(facts.get("tool")).toBe("claude");
      expect(facts.get("end reason")).toBe("not recorded (no hook)");

      const missing = findQuery("session")?.run(db, "zzzzzzzz");
      expect(missing?.rows).toEqual([]);
      expect(missing?.note).toContain("no session starts with");
    } finally {
      db.close();
    }
  });
});
