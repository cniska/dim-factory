import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestGuidance } from "./guidance";
import { SCHEMA_SQL } from "./schema";

function seeded(repos: string[]): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  repos.forEach((repo, at) => {
    db.run(
      "INSERT INTO repo_commit (sha, repo, subject, ts) VALUES (?, ?, 'feat: a', '2026-01-01T00:00:00Z')",
      [`sha${at}`, repo],
    );
  });
  return db;
}

describe("reading the rules files out of each repo", () => {
  test("skips a repo whose directory is gone instead of aborting the sync", () => {
    const db = seeded(["/tmp/dim-removed-worktree-does-not-exist"]);
    expect(() => ingestGuidance(db, { HOME: "/tmp" })).not.toThrow();
    db.close();
  });

  test("still reads a repo that is on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "dim-guidance-"));
    writeFileSync(join(root, "AGENTS.md"), "# rules\n");
    const db = seeded([root, "/tmp/dim-removed-worktree-does-not-exist"]);
    try {
      expect(ingestGuidance(db, { HOME: "/tmp" }).files).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
