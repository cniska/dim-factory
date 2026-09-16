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
        if (q.name === "session" || q.name === "search") continue; // take an argument, covered below
        const result = q.run(db, {});
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
      const cost = findQuery("cost")?.run(db, {});
      expect(cost?.rows).toEqual([]);
      expect(cost?.note).toBe("no session reported a cost");
      // Rendering an empty result must show the note, not an empty table that
      // reads as a measured zero.
      expect(renderTable(cost as never)).toContain("no session reported a cost");

      const sessions = findQuery("sessions")?.run(db, {});
      expect(sessions?.note).toContain("hooks are not installed");
    } finally {
      db.close();
    }
  });

  test("turns reports how many turns it could actually time", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const result = findQuery("turns")?.run(db, {});
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
      const result = findQuery("tokens")?.run(db, {});
      const tools = new Set(result?.rows.map((r) => r[0]));
      expect(tools).toEqual(new Set(["claude", "codex"]));
      expect(result?.note).toContain("Not summed across tools");
    } finally {
      db.close();
    }
  });

  test("a window drops the sessions outside it and says which window it used", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const inside = findQuery("tools")?.run(db, { since: "2026-09-01T00:00:00.000Z" });
      expect(inside?.rows.length).toBeGreaterThan(0);
      expect(inside?.denominator).toContain("since 2026-09-01");

      // The fixtures are stamped 2026-09-16, so a window opening the day after
      // must find nothing rather than fall back to counting all of history.
      const after = findQuery("tools")?.run(db, { since: "2026-09-17T00:00:00.000Z" });
      expect(after?.rows).toEqual([]);
      expect(after?.denominator).toContain("0 tool calls");

      const all = findQuery("tools")?.run(db, {});
      expect(all?.denominator).toContain("all time");
      expect(all?.rows.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("the window reaches the counts a rate is computed from, not just the rows", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const empty = findQuery("corrections")?.run(db, { since: "2026-09-17T00:00:00.000Z" });
      // A denominator left unwindowed would divide this window's rows by all of
      // history and read as a rate that was never measured.
      expect(empty?.denominator).toContain("0 turns the user physically stopped");
      expect(findQuery("skills")?.run(db, { since: "2026-09-17T00:00:00.000Z" })?.denominator).toContain(
        "0 loads",
      );
    } finally {
      db.close();
    }
  });

  test("search finds a message by its words and keeps the index level with the table", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const hit = findQuery("search")?.run(db, { arg: "parser" });
      expect(hit?.rows.length).toBeGreaterThan(0);
      expect(String(hit?.rows[0]?.[4])).toContain("parser");

      const miss = findQuery("search")?.run(db, { arg: "nothingmatchesthis" });
      expect(miss?.rows).toEqual([]);
      expect(miss?.note).toContain("nothing matches");
    } finally {
      db.close();
    }
  });

  test("session resolves a prefix and says so when it matches nothing", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const found = findQuery("session")?.run(db, { arg: SESSION.slice(0, 8) });
      expect(found?.denominator).toContain(SESSION);
      const facts = new Map(found?.rows.map((r) => [r[0], r[1]]));
      expect(facts.get("tool")).toBe("claude");
      expect(facts.get("end reason")).toBe("not recorded (no hook)");

      const missing = findQuery("session")?.run(db, { arg: "zzzzzzzz" });
      expect(missing?.rows).toEqual([]);
      expect(missing?.note).toContain("no session starts with");
    } finally {
      db.close();
    }
  });
});
