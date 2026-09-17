import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type RepoFileReport = { repos: number; files: number };

/** Tracked paths only: what git ignores is build output, and what it does not track was never a decision. */
export function trackedFiles(repo: string): string[] {
  const proc = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (!proc.success) return [];
  return new TextDecoder()
    .decode(proc.stdout)
    .split("\0")
    .filter(Boolean)
    .map((p) => join(repo, p));
}

/**
 * Replaced whole per repo rather than merged: a file deleted since the last sync
 * has to leave, and that is the difference between this table and `commit_file`.
 * The repos are the ones the commits already named, so this scans no disk of its
 * own — a repo that has since been deleted or moved is skipped.
 */
export function indexRepoFiles(db: Database): RepoFileReport {
  const repos = db
    .prepare<{ repo: string }, []>("SELECT DISTINCT repo FROM repo_commit ORDER BY repo")
    .all()
    .map((r) => r.repo)
    .filter((repo) => existsSync(repo));

  const clear = db.prepare("DELETE FROM repo_file WHERE repo = ?");
  const insert = db.prepare("INSERT INTO repo_file (repo, path) VALUES (?, ?) ON CONFLICT DO NOTHING");

  const report: RepoFileReport = { repos: 0, files: 0 };
  db.transaction(() => {
    for (const repo of repos) {
      const paths = trackedFiles(repo);
      if (paths.length === 0) continue;
      clear.run(repo);
      for (const path of paths) insert.run(repo, path);
      report.repos += 1;
      report.files += paths.length;
    }
  })();
  return report;
}
