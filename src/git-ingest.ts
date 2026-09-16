import type { Database } from "bun:sqlite";
import { labelFor } from "./git-remote";
import { readCommits, repoRoot } from "./git-source";

export type GitReport = { repos: number; commits: number; files: number };

/** Re-read this many days each sync, so a rebase that rewrote recent history lands. */
const OVERLAP_DAYS = 7;

/**
 * Commits for every working directory the corpus names that is still a git repo.
 * The session rows are the only source of which repos matter: this never scans
 * the disk for repos the owner never worked in from an agent session.
 */
export function ingestCommits(db: Database): GitReport {
  const cwds = db
    .prepare<{ cwd: string }, []>("SELECT DISTINCT cwd FROM session WHERE cwd IS NOT NULL")
    .all();

  const roots = new Set<string>();
  const labels = new Map<string, string | null>();
  for (const { cwd } of cwds) {
    const root = repoRoot(cwd);
    if (!root) continue;
    roots.add(root);
    if (!labels.has(root)) labels.set(root, labelFor(root));
  }

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

  const report: GitReport = { repos: roots.size, commits: 0, files: 0 };
  db.transaction(() => {
    for (const repo of roots) {
      const newest = db
        .prepare<{ ts: string | null }, [string]>("SELECT max(ts) AS ts FROM repo_commit WHERE repo = ?")
        .get(repo);
      const since = newest?.ts
        ? new Date(Date.parse(newest.ts) - OVERLAP_DAYS * 86_400_000).toISOString()
        : null;
      for (const c of readCommits(repo, since)) {
        insertCommit.run(c.sha, c.repo, labels.get(repo) ?? null, c.ts, c.author, c.subject, c.kind);
        report.commits += 1;
        for (const path of c.files) {
          insertFile.run(c.sha, `${c.repo}/${path}`);
          report.files += 1;
        }
      }
    }
  })();
  return report;
}
