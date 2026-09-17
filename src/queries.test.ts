import { Database } from "bun:sqlite";
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
import { SCHEMA_SQL } from "./schema";
import { sync } from "./sync";
import { withoutWorktree } from "./worktree";

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
        if (q.usage) continue; // takes an argument; those are covered below
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

  test("a worktree checkout collapses onto the file it is a copy of", () => {
    const db = new Database(":memory:");
    try {
      const expr = withoutWorktree("p");
      const one = (p: string) =>
        (db.query(`SELECT ${expr} AS out FROM (SELECT ? AS p)`).get(p) as { out: string }).out;

      expect(one("/h/code/apps/.claude/worktrees/neochess/docs/x.md")).toBe("/h/code/apps/docs/x.md");
      // A path with no worktree segment must come back untouched, or every file
      // in the corpus would be rewritten by this.
      expect(one("/h/code/apps/docs/x.md")).toBe("/h/code/apps/docs/x.md");
      expect(one("/h/code/apps/.claude/settings.json")).toBe("/h/code/apps/.claude/settings.json");
    } finally {
      db.close();
    }
  });

  test("prior-art ranks by recency, caps one repo, and folds its worktrees together", () => {
    const db = new Database(":memory:");
    try {
      db.run(SCHEMA_SQL);
      const repo = (n: string) => `/h/code/${n}`;
      const addFile = (r: string, p: string) =>
        db.run("INSERT INTO repo_file (repo, path) VALUES (?, ?)", [repo(r), `${repo(r)}/${p}`]);
      const addCommit = (sha: string, r: string, p: string, ts: string) => {
        db.run(
          "INSERT OR IGNORE INTO repo_commit (sha, repo, label, ts, author, subject) VALUES (?, ?, ?, ?, 'a', 's')",
          [sha, repo(r), `owner/${r}`, ts],
        );
        db.run("INSERT INTO commit_file (sha, path) VALUES (?, ?)", [sha, `${repo(r)}/${p}`]);
      };

      addFile("one", ".github/workflows/ci.yml");
      addCommit("s1", "one", ".github/workflows/ci.yml", "2026-09-10T00:00:00Z");
      // The same file reached through a worktree: one file, so one row.
      addFile("one", ".claude/worktrees/wt/.github/workflows/ci.yml");
      addCommit("s2", "one", ".claude/worktrees/wt/.github/workflows/ci.yml", "2026-09-11T00:00:00Z");

      for (const n of ["a", "b", "c", "d"]) {
        addFile("two", `.github/workflows/${n}.yml`);
        addCommit(`t${n}`, "two", `.github/workflows/${n}.yml`, "2026-09-01T00:00:00Z");
      }

      const result = findQuery("prior-art")?.run(db, { arg: ".github/workflows", home: "/h" });
      const files = result?.rows.map((r) => r[0]);
      expect(files?.[0]).toBe("code/one/.github/workflows/ci.yml");
      expect(files?.filter((f) => String(f).includes("/two/"))).toHaveLength(3);
      expect(files?.some((f) => String(f).includes("worktrees"))).toBe(false);
      // Both checkouts' commits count toward the one file they are.
      expect(result?.rows[0]?.[2]).toBe(2);
      expect(result?.denominator).toContain("6 tracked files");
    } finally {
      db.close();
    }
  });

  test("chain walks both ways from one session, across a task that was renamed", () => {
    const db = new Database(":memory:");
    try {
      db.run(SCHEMA_SQL);
      const link = (from: string, to: string, ts: string, title: string) =>
        db.run(
          `INSERT INTO handoff_link (to_message, to_session, to_ts, from_message, from_session, from_ts, title)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [`m-${to}`, to, ts, `m-${from}`, from, ts, title],
        );
      link("aaa", "bbb", "2026-09-01T10:00:00Z", "# Handoff — first name");
      link("bbb", "ccc", "2026-09-01T12:00:00Z", "# Handoff — renamed midway");
      link("ccc", "ddd", "2026-09-01T14:00:00Z", "# Handoff — renamed midway");
      // A separate chain, which must not be swept in by the title it shares.
      link("xxx", "yyy", "2026-09-02T10:00:00Z", "# Handoff — renamed midway");

      const result = findQuery("chain")?.run(db, { arg: "ccc" });
      expect(result?.rows.map((r) => r[1])).toEqual(["aaa → bbb", "bbb → ccc", "ccc → ddd"]);
      expect(result?.rows[0]?.[4]).toBe("first name");

      const all = findQuery("chain")?.run(db, {});
      expect(all?.denominator).toContain("4 links joined");
    } finally {
      db.close();
    }
  });

  test("prior-art asks for a path rather than answering over everything", () => {
    const db = new Database(":memory:");
    try {
      db.run(SCHEMA_SQL);
      const result = findQuery("prior-art")?.run(db, {});
      expect(result?.rows).toEqual([]);
      expect(result?.note).toContain("name part of a path");
    } finally {
      db.close();
    }
  });

  test("burn splits on the five-hour block, not on the day", () => {
    const env = seeded();
    const write = openDb(dbPath(env));
    try {
      // One second either side of a block edge: a day-based split would put both
      // in the same row and the boundary would stop being tested.
      for (const [id, ts] of [
        ["r-before", "2026-09-16T16:59:59.000Z"],
        ["r-after", "2026-09-16T17:00:00.000Z"],
      ]) {
        write.run(
          `INSERT INTO usage (response_id, session_id, ts, input_tokens, cache_read_tokens,
             cache_write_tokens, output_tokens) VALUES (?, ?, ?, 0, 0, 0, 1)`,
          [id as string, SESSION, ts as string],
        );
      }
    } finally {
      closeDb(write);
    }

    const db = openReadOnly(dbPath(env));
    try {
      const result = findQuery("burn")?.run(db, {});
      const blocks = new Set(result?.rows.map((r) => r[0]));
      expect(blocks.has("2026-09-16 12:00:00")).toBe(true);
      expect(blocks.has("2026-09-16 17:00:00")).toBe(true);
      expect(result?.note).toContain("how close a block came to stopping");
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
    // A corpus with nothing embedded is the keyword path, which is what has to
    // still reach every message once ranking by meaning is the first choice.
    const unranked = { unavailable: "nothing embedded in this corpus" };
    try {
      const hit = findQuery("search")?.run(db, { arg: "parser", question: unranked });
      expect(hit?.rows.length).toBeGreaterThan(0);
      expect(String(hit?.rows[0]?.[4])).toContain("parser");

      const miss = findQuery("search")?.run(db, { arg: "nothingmatchesthis", question: unranked });
      expect(miss?.rows).toEqual([]);
      expect(miss?.note).toContain("nothing matches");
    } finally {
      db.close();
    }
  });

  test("thread reads what was said, and centers on a timestamp when given one", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const whole = findQuery("thread")?.run(db, { arg: SESSION.slice(0, 8) });
      expect(whole?.rows.length).toBeGreaterThan(0);
      const texts = whole?.rows.map((r) => String(r[3])) ?? [];
      // A tool call carries no text and a skill body was said by no one; both
      // would otherwise be the largest thing in the exchange.
      expect(texts.every((t) => t.length > 0)).toBe(true);

      const centered = findQuery("thread")?.run(db, { arg: `${SESSION.slice(0, 8)}@2026-09-16T10:04` });
      expect(centered?.denominator).toContain("centered on");

      const missing = findQuery("thread")?.run(db, { arg: "zzzzzzzz" });
      expect(missing?.rows).toEqual([]);
      expect(missing?.note).toContain("no session starts with");
    } finally {
      db.close();
    }
  });

  test("skill splits one skill by version and says how thin each arm is", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const loaded = findQuery("skills")?.run(db, {});
      const name = String(loaded?.rows[0]?.[0]);
      const one = findQuery("skill")?.run(db, { arg: name });
      expect(one?.rows.length).toBeGreaterThan(0);
      // A version loaded in one session is an arm of one; a reader who meets the
      // table first will compare columns the sample cannot carry.
      expect(one?.denominator).toMatch(/\d+ of them were loaded in a single session/);

      const never = findQuery("skill")?.run(db, { arg: "no-such-skill" });
      expect(never?.rows).toEqual([]);
      expect(never?.note).toContain("no load of no-such-skill recorded");
      expect(never?.denominator).not.toContain("single session");
    } finally {
      db.close();
    }
  });

  test("delegation counts a handoff without claiming the delegate's work was per-call", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const d = findQuery("delegation")?.run(db, {});
      expect(d?.denominator).toMatch(/\d+ agents spawned and \d+ messages sent to a peer/);
      // A skill's children are every child of a session it delegated in, so the
      // figure must not read as the work these calls returned.
      if ((d?.rows.length ?? 0) > 0) expect(d?.note).toContain("rather than a per-call figure");
    } finally {
      db.close();
    }
  });

  test("running says it is only as fresh as the last sync", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      // The fixtures are older than any live window, so this must read as
      // nothing running rather than as nothing to see.
      const quiet = findQuery("running")?.run(db, { arg: "1" });
      expect(quiet?.rows).toEqual([]);
      expect(quiet?.note).toContain("dim sync");
      expect(quiet?.denominator).toContain("last 1 minutes");
    } finally {
      db.close();
    }
  });

  test("fixes counts only what someone came back to after the session ended", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const f = findQuery("fixes")?.run(db, {});
      // The fixtures have no repo on disk, so this must say the commits are
      // missing rather than report a clean zero-defect rate.
      expect(f?.rows).toEqual([]);
      expect(f?.note).toContain("no commits read");
      expect(f?.denominator).toContain("fix commits");
    } finally {
      db.close();
    }
  });

  test("repeats counts what was said, not what was pasted in", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const r = findQuery("repeats")?.run(db, {});
      expect(r?.denominator).toContain("phrases of 4 words");
      // A corpus this small has nothing recurring across three sessions, and that
      // has to read as no evidence rather than as an empty finding.
      expect(r?.rows).toEqual([]);
      expect(r?.note).toContain("nothing recurs");
    } finally {
      db.close();
    }
  });

  test("stale says it cannot score without commits, rather than scoring zero", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const r = findQuery("stale")?.run(db, {});
      // The fixtures have no repo on disk, so every session would otherwise
      // score as untouched — which reads as durable rather than as unmeasured.
      expect(r?.rows).toEqual([]);
      expect(r?.denominator).toContain("no commits read");
      expect(r?.note).toContain("no measure of movement");
    } finally {
      db.close();
    }
  });

  test("resume gives facts for a cold start and never a next move", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const r = findQuery("resume")?.run(db, { arg: SESSION.slice(0, 8) });
      const what = (r?.rows ?? []).map((row) => String(row[0]));
      expect(what).toContain("branch");
      expect(what).toContain("said");
      // The judgement a handoff exists to make is not a fact in the database, and
      // a row claiming it would read as one.
      expect(what).not.toContain("next");
      expect(r?.note).toContain("Facts only");

      const missing = findQuery("resume")?.run(db, { arg: "zzzzzzzz" });
      expect(missing?.rows).toEqual([]);
      expect(missing?.note).toContain("no session starts with");
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

describe("the sql escape hatch", () => {
  test("the read-only connection refuses every statement that writes", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      // The guarantee is SQLite's, not a rule here about what a statement looks
      // like: a rule would have to be right about every spelling of a write.
      expect(() => db.prepare("DELETE FROM session").all()).toThrow();
      expect(() => db.prepare("UPDATE session SET cwd = 'x'").all()).toThrow();
      expect(() => db.prepare("DROP TABLE message").all()).toThrow();
      expect(() => db.prepare("CREATE TABLE t (a INT)").all()).toThrow();
      expect(() => db.prepare("INSERT INTO session (id, tool) VALUES ('x','claude')").all()).toThrow();

      const rows = db.prepare("SELECT count(*) AS n FROM session").all() as { n: number }[];
      expect(rows[0]?.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
