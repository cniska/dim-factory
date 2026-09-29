import { type Query, requiredArg, scalar, table, toRows } from "./query";
import { withoutWorktree } from "./worktree";

const PER_REPO = 3;

export const priorArt: Query = {
  name: "prior-art",
  summary: "where a path like this one already exists across the repos on disk, newest first",
  usage: 'dim q prior-art "<path fragment>"',
  window: "none",
  run: (db, ctx) => {
    const columns = ["file", "repo", "commits", "days_since", "authors"];
    const fragment = requiredArg(ctx, priorArt.usage);
    const records = table(
      db,
      `WITH matched AS (
         SELECT ${withoutWorktree("f.path")} AS path, f.path AS real_path, f.repo AS repo
         FROM repo_file f
         WHERE f.path LIKE '%' || ? || '%'
       ),
       dated AS (
         SELECT m.path AS path,
                coalesce(min(c.label), replace(min(m.repo), ? || '/', '')) AS repo,
                count(DISTINCT cf.sha) AS commits,
                cast(julianday('now') - julianday(max(rc.ts)) AS INTEGER) AS days_since,
                count(DISTINCT rc.author) AS authors
         FROM matched m
         LEFT JOIN (SELECT DISTINCT repo, label FROM repo_commit WHERE label IS NOT NULL) c
           ON c.repo = m.repo
         LEFT JOIN commit_file cf ON cf.path = m.real_path
         LEFT JOIN repo_commit rc ON rc.sha = cf.sha
         GROUP BY m.path
       ),
       ranked AS (
         SELECT *, row_number() OVER (
           PARTITION BY repo ORDER BY days_since IS NULL, days_since ASC, commits DESC
         ) AS rank_in_repo
         FROM dated
       )
       SELECT replace(path, ? || '/', '') AS file, repo, commits, days_since, authors
       FROM ranked
       WHERE rank_in_repo <= ${PER_REPO}
       ORDER BY days_since IS NULL, days_since ASC, commits DESC
       LIMIT 25`,
      [fragment, ctx.home, ctx.home],
    );

    const repos = new Set(records.map((r) => r.repo)).size;
    const total = scalar(db, "SELECT count(*) AS n FROM repo_file WHERE path LIKE '%' || ? || '%'", fragment);
    return {
      denominator:
        `${total} tracked files match "${fragment}", in ${repos} of ` +
        `${scalar(db, "SELECT count(DISTINCT repo) AS n FROM repo_file")} repos indexed` +
        (records.length < total ? `; the ${records.length} most recently touched are shown` : ""),
      columns,
      rows: toRows(records, columns),
      note:
        total === 0
          ? "nothing on disk matches; `dim sync` indexes the repos the corpus names, and only those"
          : "Recency and commit count, not quality: this cannot tell a file that was got right from one that was " +
            "abandoned, and a file copied between repos looks as settled as one that was worked out. A repo the " +
            "owner only cloned ranks beside their own, so read the repo column before the file. `days_since` is " +
            "empty for a file no commit in the corpus has touched.",
    };
  },
};
