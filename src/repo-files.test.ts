import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepoFiles, trackedFiles } from "./repo-files";
import { SCHEMA_SQL } from "./schema";

function repoWith(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "dim-files-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  writeFileSync(join(dir, ".gitignore"), "dist/\n");
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "x");
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "--no-verify", "-q", "-m", "feat: the first commit"]);
  return dir;
}

function dbNaming(repo: string): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  db.run("INSERT INTO repo_commit (sha, repo, ts, subject) VALUES ('a1', ?, '2026-01-01T00:00:00Z', 's')", [
    repo,
  ]);
  return db;
}

const pathsIn = (db: Database, repo: string): string[] =>
  (db.prepare("SELECT path FROM repo_file ORDER BY path").all() as { path: string }[]).map((r) =>
    r.path.replace(`${repo}/`, ""),
  );

describe("indexing what a repo tracks", () => {
  test("records tracked files and leaves ignored ones out", () => {
    const repo = repoWith([".github/workflows/ci.yml", "src/cli.ts"]);
    try {
      mkdirSync(join(repo, "dist"), { recursive: true });
      writeFileSync(join(repo, "dist", "cli.js"), "x");
      expect(trackedFiles(repo).some((p) => p.endsWith("dist/cli.js"))).toBe(false);

      const db = dbNaming(repo);
      expect(indexRepoFiles(db)).toEqual({ repos: 1, files: 3 });
      expect(pathsIn(db, repo)).toEqual([".github/workflows/ci.yml", ".gitignore", "src/cli.ts"]);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("drops a file the repo no longer tracks", () => {
    const repo = repoWith(["keep.ts", "gone.ts"]);
    try {
      const db = dbNaming(repo);
      indexRepoFiles(db);
      expect(pathsIn(db, repo)).toContain("gone.ts");

      execFileSync("git", ["-C", repo, "rm", "-q", "gone.ts"]);
      execFileSync("git", ["-C", repo, "commit", "--no-verify", "-q", "-m", "chore: drop it"]);
      indexRepoFiles(db);
      expect(pathsIn(db, repo)).not.toContain("gone.ts");
      expect(pathsIn(db, repo)).toContain("keep.ts");
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("skips a repo the corpus names that is no longer on disk", () => {
    const repo = repoWith(["a.ts"]);
    const db = dbNaming(repo);
    rmSync(repo, { recursive: true, force: true });
    expect(indexRepoFiles(db)).toEqual({ repos: 0, files: 0 });
    db.close();
  });
});
