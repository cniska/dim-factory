import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import { indexRepoFiles, trackedFiles } from "./repo-files";

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

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

const failures: { path: string; code: unknown }[] = [];
const fail = (path: string, error: unknown) =>
  failures.push({ path, code: (error as { code?: unknown }).code });

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

      const db = freshDb();
      expect(indexRepoFiles(db, [repo], fail)).toEqual({ repos: 1, files: 3 });
      expect(pathsIn(db, repo)).toEqual([".github/workflows/ci.yml", ".gitignore", "src/cli.ts"]);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("drops a file the repo no longer tracks", () => {
    const repo = repoWith(["keep.ts", "gone.ts"]);
    try {
      const db = freshDb();
      indexRepoFiles(db, [repo], fail);
      expect(pathsIn(db, repo)).toContain("gone.ts");

      execFileSync("git", ["-C", repo, "rm", "-q", "gone.ts"]);
      execFileSync("git", ["-C", repo, "commit", "--no-verify", "-q", "-m", "chore: drop it"]);
      indexRepoFiles(db, [repo], fail);
      expect(pathsIn(db, repo)).not.toContain("gone.ts");
      expect(pathsIn(db, repo)).toContain("keep.ts");

      execFileSync("git", ["-C", repo, "rm", "-q", "-r", "."]);
      indexRepoFiles(db, [repo], fail);
      expect(pathsIn(db, repo)).toEqual([]);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("reports a repo git cannot read and still indexes the others", () => {
    const repo = repoWith(["a.ts"]);
    const gone = repoWith(["b.ts"]);
    rmSync(gone, { recursive: true, force: true });
    failures.length = 0;
    try {
      const db = freshDb();
      expect(indexRepoFiles(db, [gone, repo], fail)).toEqual({ repos: 1, files: 2 });
      expect(failures).toEqual([{ path: gone, code: "git_failed" }]);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
