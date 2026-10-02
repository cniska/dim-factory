import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { openReadOnly } from "./db-read";
import { SCHEMA_SQL } from "./db-schema";
import { scratchEnv, writeClaudeTranscript, writeCodexRollout } from "./fixtures.test-support";
import { sync } from "./ingest-sync";
import { dbPath, type Env } from "./paths";
import type { QueryContext } from "./query";
import { findQuery } from "./query-registry";

const ctx: QueryContext = { home: "/h", maxRows: 40 };

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
      addFile("one", ".claude/worktrees/wt/.github/workflows/ci.yml");
      addCommit("s2", "one", ".claude/worktrees/wt/.github/workflows/ci.yml", "2026-09-11T00:00:00Z");

      for (const n of ["a", "b", "c", "d"]) {
        addFile("two", `.github/workflows/${n}.yml`);
        addCommit(`t${n}`, "two", `.github/workflows/${n}.yml`, "2026-09-01T00:00:00Z");
      }

      const result = findQuery("prior-art")?.run(db, { ...ctx, arg: ".github/workflows", home: "/h" });
      const files = result?.rows.map((r) => r[0]);
      expect(files?.[0]).toBe("code/one/.github/workflows/ci.yml");
      expect(files?.filter((f) => String(f).includes("/two/"))).toHaveLength(3);
      expect(files?.some((f) => String(f).includes("worktrees"))).toBe(false);
      expect(result?.rows[0]?.[2]).toBe(2);
      expect(result?.denominator).toContain("6 tracked files");
    } finally {
      db.close();
    }
  });

  test("prior-art refuses a missing path as a usage error rather than answering over everything", () => {
    const db = new Database(":memory:");
    try {
      db.run(SCHEMA_SQL);
      expect(() => findQuery("prior-art")?.run(db, ctx)).toThrow(
        expect.objectContaining({
          code: "usage",
          message: 'usage: dim query prior-art "<path fragment>"',
        }),
      );
    } finally {
      db.close();
    }
  });

  test("search finds a message by its words and keeps the index level with the table", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const hit = findQuery("search")?.run(db, { ...ctx, arg: "parser" });
      expect(hit?.rows.length).toBeGreaterThan(0);
      expect(String(hit?.rows[0]?.[hit.columns.indexOf("text")])).toContain("parser");

      const miss = findQuery("search")?.run(db, { ...ctx, arg: "nothingmatchesthis" });
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
      const whole = findQuery("thread")?.run(db, { ...ctx, arg: SESSION.slice(0, 8) });
      expect(whole?.rows.length).toBeGreaterThan(0);
      const texts = whole?.rows.map((r) => String(r[3])) ?? [];
      expect(texts.every((t) => t.length > 0)).toBe(true);

      const centered = findQuery("thread")?.run(db, {
        ...ctx,
        arg: `${SESSION.slice(0, 8)}@2026-09-16T10:04`,
      });
      expect(centered?.denominator).toContain("centered on");

      const missing = findQuery("thread")?.run(db, { ...ctx, arg: "zzzzzzzz" });
      expect(missing?.rows).toEqual([]);
      expect(missing?.note).toContain("no session starts with");

      expect(() => findQuery("thread")?.run(db, ctx)).toThrow(
        expect.objectContaining({
          code: "usage",
          message: "usage: dim query thread <id-prefix>[@<ts>]",
        }),
      );
      expect(() => findQuery("thread")?.run(db, { ...ctx, arg: "" })).toThrow(
        expect.objectContaining({ code: "usage" }),
      );
    } finally {
      db.close();
    }
  });
});
