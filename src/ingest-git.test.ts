import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
import { ingestCommits, repoRoots } from "./ingest-git";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function dir(name: string): string {
  const made = mkdtempSync(join(tmpdir(), `dim-ingest-git-${name}-`));
  roots.push(made);
  return made;
}

function repoWithCommit(): string {
  const repo = dir("healthy");
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args]);
  git("init", "-q");
  writeFileSync(join(repo, "a.ts"), "x");
  git("add", "a.ts");
  git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--no-verify", "-q", "-m", "feat: a");
  return repo;
}

function brokenCheckout(): string {
  const broken = dir("broken");
  writeFileSync(join(broken, ".git"), "gitdir: /nonexistent/dim-test\n");
  return broken;
}

describe("reading the repos the sessions ran in", () => {
  test("names a checkout git cannot read as a failure and reads the others", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    const failed: { path: string; code: unknown }[] = [];
    const fail = (path: string, error: unknown) =>
      failed.push({ path, code: (error as { code?: unknown }).code });
    const healthy = repoWithCommit();
    const broken = brokenCheckout();

    expect(ingestCommits(db, [broken, healthy], fail)).toEqual({ repos: 1, commits: 1, files: 1 });
    expect(failed).toEqual([{ path: broken, code: "git_failed" }]);
    expect(db.query("SELECT subject FROM repo_commit").all()).toEqual([{ subject: "feat: a" }]);

    db.run("INSERT INTO session (id, tool, cwd) VALUES ('s1', 'claude', ?)", [broken]);
    failed.length = 0;
    expect(repoRoots(db, fail)).toEqual([]);
    expect(failed).toEqual([{ path: broken, code: "git_failed" }]);
    db.close();
  });
});
