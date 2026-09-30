import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import { drainWalk, resolveWalk, spoolWalk } from "./guidance-walk";
import { walkSpoolDir } from "./ingest-spool";
import { type Env, spoolDir } from "./paths";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-walk-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function home(root: string): Env {
  const dir = join(root, "home");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  return { HOME: dir, XDG_DATA_HOME: join(root, "data") };
}

describe("the walk a session starts with", () => {
  test("records an imported file against the one that imported it", () => {
    const root = newRoot();
    const env = home(root);
    const claude = join(env.HOME as string, ".claude");
    writeFileSync(join(claude, "CLAUDE.md"), "@RTK.md\n\n# Conventions\n");
    writeFileSync(join(claude, "RTK.md"), "# RTK\n");

    const walk = resolveWalk("claude", root, env);
    expect(walk.map((s) => [s.path, s.importedBy])).toEqual([
      [join(claude, "CLAUDE.md"), null],
      [join(claude, "RTK.md"), join(claude, "CLAUDE.md")],
    ]);
    expect(walk[0]?.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  test("takes only a line that is nothing but an import", () => {
    const root = newRoot();
    const env = home(root);
    const claude = join(env.HOME as string, ".claude");
    writeFileSync(join(claude, "CLAUDE.md"), "Ask @someone about @RTK.md before editing.\n");
    writeFileSync(join(claude, "RTK.md"), "# RTK\n");
    expect(resolveWalk("claude", root, env).map((s) => s.path)).toEqual([join(claude, "CLAUDE.md")]);
  });

  test("reads the project's own rules file alongside the user's", () => {
    const root = newRoot();
    const env = home(root);
    writeFileSync(join(env.HOME as string, ".claude", "CLAUDE.md"), "# user\n");
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "# project\n");
    expect(resolveWalk("claude", repo, env).map((s) => s.path)).toContain(join(repo, "AGENTS.md"));
  });

  test("stops on a cycle", () => {
    const root = newRoot();
    const env = home(root);
    const claude = join(env.HOME as string, ".claude");
    writeFileSync(join(claude, "CLAUDE.md"), "@RTK.md\n");
    writeFileSync(join(claude, "RTK.md"), "@CLAUDE.md\n");
    expect(resolveWalk("claude", root, env)).toHaveLength(2);
  });

  test("names no surface that is not a regular file of a readable size", () => {
    const root = newRoot();
    const env = home(root);
    const claude = join(env.HOME as string, ".claude");
    writeFileSync(join(claude, "CLAUDE.md"), "@huge.md\n@folder.md\n");
    writeFileSync(join(claude, "huge.md"), "x".repeat(1024 * 1024 + 1));
    mkdirSync(join(claude, "folder.md"));
    expect(resolveWalk("claude", root, env).map((s) => s.path)).toEqual([join(claude, "CLAUDE.md")]);
  });

  test("a session start is not held by a rules file that never delivers", async () => {
    const root = newRoot();
    const env = home(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("mkfifo", [join(repo, "AGENTS.md")]);

    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "cli.ts"), "hooks", "start"], {
      cwd: repo,
      env: { ...process.env, ...env },
      stdin: new Blob([JSON.stringify({ session_id: "s-fifo", cwd: repo })]),
      stdout: "ignore",
      stderr: "ignore",
    });
    const outcome = await Promise.race([
      child.exited,
      new Promise((r) => setTimeout(() => r("still reading"), 4000)),
    ]);
    child.kill();
    expect(outcome).toBe(0);
  }, 10_000);

  test("names no surface that is not on disk", () => {
    const root = newRoot();
    const env = home(root);
    writeFileSync(join(env.HOME as string, ".claude", "CLAUDE.md"), "@missing.md\n");
    expect(resolveWalk("claude", root, env).map((s) => s.path)).toEqual([
      join(env.HOME as string, ".claude", "CLAUDE.md"),
    ]);
  });
});

describe("the walk spool", () => {
  test("carries a session start through to the table and clears the file", () => {
    const root = newRoot();
    const env = home(root);
    const db = new Database(":memory:");
    try {
      db.run(SCHEMA_SQL);
      spoolWalk(
        {
          session_id: "s-1",
          tool: "claude",
          seen_at: "2026-09-17T10:00:00.000Z",
          surfaces: [
            { path: "/h/.claude/CLAUDE.md", sha: "aa", importedBy: null },
            { path: "/h/.claude/RTK.md", sha: "bb", importedBy: "/h/.claude/CLAUDE.md" },
          ],
        },
        env,
      );
      expect(drainWalk(db, env)).toEqual({ sessions: 1, surfaces: 2, unreadable: 0 });
      expect(
        db.query("SELECT path, imported_by FROM guidance_walk WHERE session_id = 's-1' ORDER BY path").all(),
      ).toEqual([
        { path: "/h/.claude/CLAUDE.md", imported_by: null },
        { path: "/h/.claude/RTK.md", imported_by: "/h/.claude/CLAUDE.md" },
      ]);
      expect(drainWalk(db, env)).toEqual({ sessions: 0, surfaces: 0, unreadable: 0 });
    } finally {
      db.close();
    }
  });

  test("a drain that fails partway keeps every walk for the next one", () => {
    const root = newRoot();
    const env = home(root);
    const db = new Database(":memory:");
    try {
      db.run(SCHEMA_SQL);
      const dir = walkSpoolDir(env);
      mkdirSync(dir, { recursive: true });
      const walk = (session: string) =>
        JSON.stringify({
          session_id: session,
          tool: "claude",
          seen_at: "2026-09-17T10:00:00.000Z",
          surfaces: [{ path: "/h/.claude/CLAUDE.md", sha: "aa", importedBy: null }],
        });
      writeFileSync(join(dir, "1789000000000-1.json"), walk("s-kept"));
      writeFileSync(join(dir, "1789000000000-2.json"), walk("s-refused"));
      db.run(
        `CREATE TRIGGER refuse BEFORE INSERT ON guidance_walk
         WHEN NEW.session_id = 's-refused' BEGIN SELECT RAISE(ABORT, 'refused'); END`,
      );
      expect(() => drainWalk(db, env)).toThrow("refused");
      expect(db.query("SELECT count(*) AS n FROM guidance_walk").get()).toEqual({ n: 0 });
      expect(readdirSync(dir).sort()).toEqual(["1789000000000-1.json", "1789000000000-2.json"]);

      db.run("DROP TRIGGER refuse");
      expect(drainWalk(db, env)).toEqual({ sessions: 2, surfaces: 2, unreadable: 0 });
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("writes nothing for a session that found no rules file at all", () => {
    const root = newRoot();
    const env = home(root);
    const db = new Database(":memory:");
    try {
      db.run(SCHEMA_SQL);
      spoolWalk({ session_id: "s-2", tool: "codex", seen_at: "2026-09-17T10:00:00.000Z", surfaces: [] }, env);
      expect(drainWalk(db, env)).toEqual({ sessions: 0, surfaces: 0, unreadable: 0 });
    } finally {
      db.close();
    }
  });

  test("sets aside a file it cannot place and counts it, rather than meeting it on every sync", () => {
    const root = newRoot();
    const env = home(root);
    const db = new Database(":memory:");
    try {
      db.run(SCHEMA_SQL);
      const dir = walkSpoolDir(env);
      mkdirSync(dir, { recursive: true });
      const truncated = join(dir, "1789000000000-1.json");
      const foreign = join(dir, "1789000000000-2.json");
      writeFileSync(truncated, "{not json");
      writeFileSync(
        foreign,
        JSON.stringify({
          session_id: "s-3",
          tool: "vim",
          seen_at: "2026-09-17T10:00:00.000Z",
          surfaces: [{ path: "/h/.vimrc", sha: "cc", importedBy: null }],
        }),
      );
      expect(drainWalk(db, env)).toEqual({ sessions: 0, surfaces: 0, unreadable: 2 });
      expect(existsSync(truncated) || existsSync(foreign)).toBe(false);
      expect(readdirSync(join(spoolDir(env), "unreadable")).sort()).toEqual([
        "1789000000000-1.json",
        "1789000000000-2.json",
      ]);
      expect(drainWalk(db, env)).toEqual({ sessions: 0, surfaces: 0, unreadable: 0 });
    } finally {
      db.close();
    }
  });
});
