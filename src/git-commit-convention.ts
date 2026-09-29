import type { Database } from "bun:sqlite";
import { labelFor } from "./git-remote";
import { withoutWorktree } from "./worktree";

export const CONVENTION_FLOOR = 20;

export type RepoConvention = {
  commits: number;
  observed: {
    conventionalPct: number;
    meanLength: number;
    over50Pct: number;
    squashedPct: number;
    topKinds: string[];
  } | null;
};

export type CheckoutConvention = RepoConvention & { repo: string };

export function checkoutConvention(db: Database, root: string): CheckoutConvention {
  const label = labelFor(root);
  return { repo: label ?? root, ...repoConvention(db, { label, root }) };
}

type ConventionRow = {
  commits: number;
  conventional_pct: number;
  mean_len: number;
  over_50_pct: number;
  squashed_pct: number;
  top_kinds: string | null;
};

export function repoConvention(db: Database, repo: { label: string | null; root: string }): RepoConvention {
  const [where, key] =
    repo.label === null
      ? [`label IS NULL AND ${withoutWorktree("repo")} = ?`, repo.root]
      : ["label = ?", repo.label];
  const row = db
    .prepare(
      `WITH f AS (SELECT subject, kind FROM repo_commit WHERE ${where})
       SELECT count(*) AS commits,
              round(100.0 * sum(kind IS NOT NULL) / count(*)) AS conventional_pct,
              round(avg(length(subject))) AS mean_len,
              round(100.0 * sum(length(subject) > 50) / count(*)) AS over_50_pct,
              round(100.0 * sum(subject GLOB '*(#[0-9]*)') / count(*)) AS squashed_pct,
              (SELECT group_concat(k, ' ') FROM
                 (SELECT kind AS k FROM f WHERE kind IS NOT NULL
                  GROUP BY kind ORDER BY count(*) DESC LIMIT 3)) AS top_kinds
       FROM f`,
    )
    .get(key) as ConventionRow;
  return {
    commits: row.commits,
    observed:
      row.commits < CONVENTION_FLOOR
        ? null
        : {
            conventionalPct: row.conventional_pct,
            meanLength: row.mean_len,
            over50Pct: row.over_50_pct,
            squashedPct: row.squashed_pct,
            topKinds: row.top_kinds?.split(" ") ?? [],
          },
  };
}
