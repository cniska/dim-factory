import type { Database } from "bun:sqlite";
import { labelFor } from "./git-remote";
import { withoutWorktree } from "./worktree";

export const CONVENTION_FLOOR = 20;

export type ConventionRecord = {
  repo: string;
  commits: number;
  conventional_pct: number;
  mean_len: number;
  over_50_pct: number;
  squashed_pct: number;
  top_kinds: string | null;
};

export type ConventionScope = { home: string; conds: string[]; params: unknown[] };

function scoped(scope: ConventionScope): { sql: string; params: unknown[] } {
  return {
    sql: `WITH c AS (
         SELECT coalesce(label, replace(${withoutWorktree("repo")}, ? || '/', '')) AS repo_key,
                repo, label, subject, kind, ts
         FROM repo_commit
       ),
       f AS (SELECT * FROM c ${scope.conds.length ? `WHERE ${scope.conds.join(" AND ")}` : ""})`,
    params: [scope.home, ...scope.params],
  };
}

export function conventionRecords(db: Database, scope: ConventionScope, limit: number): ConventionRecord[] {
  const { sql, params } = scoped(scope);
  return db
    .prepare(
      `${sql}
       SELECT repo_key AS repo,
              count(*) AS commits,
              round(100.0 * sum(kind IS NOT NULL) / count(*)) AS conventional_pct,
              round(avg(length(subject))) AS mean_len,
              round(100.0 * sum(length(subject) > 50) / count(*)) AS over_50_pct,
              -- The suffix must close the subject and carry a number, or a
              -- parenthesized tag and a bare issue reference both read as a
              -- merge that never happened.
              round(100.0 * sum(subject GLOB '*(#[0-9]*)') / count(*)) AS squashed_pct,
              (SELECT group_concat(k, ' ') FROM
                 (SELECT g.kind AS k FROM f g
                  WHERE g.repo_key = f.repo_key AND g.kind IS NOT NULL
                  GROUP BY g.kind ORDER BY count(*) DESC LIMIT 3)) AS top_kinds
       FROM f
       GROUP BY repo_key
       HAVING commits >= ${CONVENTION_FLOOR}
       ORDER BY commits DESC LIMIT ${limit}`,
    )
    .all(...(params as [])) as ConventionRecord[];
}

export function conventionCommits(db: Database, scope: ConventionScope): number {
  const { sql, params } = scoped(scope);
  const row = db.prepare(`${sql} SELECT count(*) AS n FROM f`).get(...(params as [])) as { n: number };
  return row.n;
}

export type CheckoutConvention = RepoConvention & { repo: string };

export function checkoutConvention(db: Database, root: string): CheckoutConvention {
  const label = labelFor(root);
  return { repo: label ?? root, ...repoConvention(db, { label, root }) };
}

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

export function repoConvention(db: Database, repo: { label: string | null; root: string }): RepoConvention {
  const scope: ConventionScope =
    repo.label === null
      ? { home: "", conds: [`label IS NULL AND ${withoutWorktree("repo")} = ?`], params: [repo.root] }
      : { home: "", conds: ["label = ?"], params: [repo.label] };
  const commits = conventionCommits(db, scope);
  const [record] = conventionRecords(db, scope, 1);
  return {
    commits,
    observed: record
      ? {
          conventionalPct: record.conventional_pct,
          meanLength: record.mean_len,
          over50Pct: record.over_50_pct,
          squashedPct: record.squashed_pct,
          topKinds: record.top_kinds?.split(" ") ?? [],
        }
      : null,
  };
}
