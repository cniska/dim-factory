import type { Database } from "bun:sqlite";
import { checkCommand } from "./workspace-commands";

export type RepoCheckReport = { repos: number };

export function recordRepoChecks(db: Database): RepoCheckReport {
  const repos = db
    .prepare<{ repo: string }, []>("SELECT DISTINCT project AS repo FROM session WHERE project IS NOT NULL")
    .all();
  const upsert = db.prepare(
    `INSERT INTO repo_check (repo, command) VALUES (?, ?)
     ON CONFLICT(repo) DO UPDATE SET command = excluded.command`,
  );
  db.transaction(() => {
    for (const { repo } of repos) upsert.run(repo, checkCommand(repo)?.command ?? null);
  })();
  return { repos: repos.length };
}
