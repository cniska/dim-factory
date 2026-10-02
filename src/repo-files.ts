import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { writeTransaction } from "./db";
import { nulFields, ranRaw } from "./git";
import type { RepoFailure } from "./ingest-git";

export type RepoFileReport = { repos: number; files: number };

export function trackedFiles(repo: string): string[] {
  return nulFields(ranRaw(repo, ["ls-files", "-z"]), "git ls-files -z").map((path) => join(repo, path));
}

export function indexRepoFiles(db: Database, roots: readonly string[], fail: RepoFailure): RepoFileReport {
  const clear = db.prepare("DELETE FROM repo_file WHERE repo = ?");
  const insert = db.prepare("INSERT INTO repo_file (repo, path) VALUES (?, ?) ON CONFLICT DO NOTHING");

  const report: RepoFileReport = { repos: 0, files: 0 };
  writeTransaction(db, () => {
    for (const repo of roots) {
      let paths: string[];
      try {
        paths = trackedFiles(repo);
      } catch (error) {
        fail(repo, error);
        continue;
      }
      clear.run(repo);
      for (const path of paths) insert.run(repo, path);
      report.repos += 1;
      report.files += paths.length;
    }
  });
  return report;
}
