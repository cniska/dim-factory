import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { labelFor } from "./git-remote";
import { readCommits, repoRoot } from "./ingest-git-source";
import { isScratchRepo } from "./ingest-scratch";

export type GitReport = { repos: number; commits: number; files: number };

export type RepoFailure = (path: string, error: unknown) => void;

const OVERLAP_DAYS = 7;

export function repoRoots(db: Database, fail: RepoFailure): readonly string[] {
  const cwds = db
    .query<{ cwd: string }, []>("SELECT DISTINCT cwd FROM session WHERE cwd IS NOT NULL ORDER BY cwd")
    .all();
  const roots = new Set<string>();
  for (const { cwd } of cwds) {
    try {
      const root = repoRoot(cwd);
      if (root !== null && !isScratchRepo(root)) roots.add(root);
    } catch (error) {
      fail(cwd, error);
    }
  }
  return [...roots];
}

export function ingestCommits(db: Database, roots: readonly string[], fail: RepoFailure): GitReport {
  const insertCommit = db.prepare(
    `INSERT INTO repo_commit (sha, repo, label, ts, author, subject, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sha) DO UPDATE SET
       repo = excluded.repo, label = coalesce(excluded.label, repo_commit.label),
       ts = excluded.ts, author = excluded.author,
       subject = excluded.subject, kind = excluded.kind`,
  );
  const insertFile = db.prepare(
    "INSERT INTO commit_file (sha, path) VALUES (?, ?) ON CONFLICT(sha, path) DO NOTHING",
  );
  const newestOf = db.query<{ ts: string | null }, [string]>(
    "SELECT max(ts) AS ts FROM repo_commit WHERE repo = ?",
  );

  const report: GitReport = { repos: 0, commits: 0, files: 0 };
  writeTransaction(db, () => {
    for (const repo of roots) {
      const newest = newestOf.get(repo)?.ts;
      const since = newest ? new Date(Date.parse(newest) - OVERLAP_DAYS * 86_400_000).toISOString() : null;
      let read: { label: string | null; commits: ReturnType<typeof readCommits> };
      try {
        read = { label: labelFor(repo), commits: readCommits(repo, since) };
      } catch (error) {
        fail(repo, error);
        continue;
      }
      report.repos += 1;
      for (const c of read.commits) {
        insertCommit.run(c.sha, c.repo, read.label, c.ts, c.author, c.subject, c.kind);
        report.commits += 1;
        for (const path of c.files) {
          insertFile.run(c.sha, `${c.repo}/${path}`);
          report.files += 1;
        }
      }
    }
  });
  return report;
}
