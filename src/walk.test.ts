import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "./paths";
import { SCHEMA_SQL } from "./schema";
import { drainWalk, resolveWalk, spoolWalk } from "./walk";

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
  return { HOME: dir, DIM_HOME: join(root, "data") };
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
      expect(drainWalk(db, env)).toEqual({ sessions: 1, surfaces: 2 });
      expect(
        db.query("SELECT path, imported_by FROM guidance_walk WHERE session_id = 's-1' ORDER BY path").all(),
      ).toEqual([
        { path: "/h/.claude/CLAUDE.md", imported_by: null },
        { path: "/h/.claude/RTK.md", imported_by: "/h/.claude/CLAUDE.md" },
      ]);
      expect(drainWalk(db, env)).toEqual({ sessions: 0, surfaces: 0 });
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
      expect(drainWalk(db, env)).toEqual({ sessions: 0, surfaces: 0 });
    } finally {
      db.close();
    }
  });
});
