import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "./schema";
import { sync } from "./sync";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

test("sync records the repository check returned by checkTask", () => {
  const repo = mkdtempSync(join(tmpdir(), "dim-repo-check-"));
  roots.push(repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { verify: "bun test" } }));
  writeFileSync(join(repo, "bun.lock"), "");

  const db = new Database(":memory:");
  try {
    db.run(SCHEMA_SQL);
    db.run("INSERT INTO session (id, tool, cwd, project) VALUES ('s1', 'codex', ?, ?)", [repo, repo]);
    sync(db, { HOME: repo, DIM_HOME: repo });
    expect(db.query("SELECT repo, command FROM repo_check").all()).toEqual([
      { repo, command: "bun run verify" },
    ]);
  } finally {
    db.close();
  }
});

test("sync records null for a repository with no declared check", () => {
  const repo = mkdtempSync(join(tmpdir(), "dim-repo-check-"));
  roots.push(repo);
  const db = new Database(":memory:");
  try {
    db.run(SCHEMA_SQL);
    db.run("INSERT INTO session (id, tool, cwd, project) VALUES ('s1', 'codex', ?, ?)", [repo, repo]);
    sync(db, { HOME: repo, DIM_HOME: repo });
    expect(db.query("SELECT repo, command FROM repo_check").all()).toEqual([{ repo, command: null }]);
  } finally {
    db.close();
  }
});
