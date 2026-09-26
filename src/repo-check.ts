import type { Database } from "bun:sqlite";
import { checkTask } from "./workspace-tasks";

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
    for (const { repo } of repos) upsert.run(repo, checkTask(repo)?.commandLine ?? null);
  })();
  return { repos: repos.length };
}
