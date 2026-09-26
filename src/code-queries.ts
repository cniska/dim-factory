import { CONVENTION_FLOOR, conventionCommits, conventionRecords } from "./commit-convention";
import {
  CLAUDE_EDITS,
  claudeOnly,
  homeOf,
  type Query,
  scalar,
  table,
  toRows,
  window,
  windowLine,
} from "./query";
import { withoutWorktree } from "./worktree";

export const exemplars: Query = {
  name: "exemplars",
  summary: "code an agent wrote that shipped and no fix came back to — candidates, not verdicts",
  window: "t.ts_call",
  run: (db, ctx) => {
    const columns = ["file", "repo", "skill", "edits", "commits", "days_since"];
    const w = window("t.ts_call", ctx);
    const records = table(
      db,
      `WITH edited AS (
         SELECT ${withoutWorktree("t.file_path")} AS path, coalesce(t.attribution_skill, '(no skill)') AS skill,
                count(*) AS edits, max(t.ts_call) AS last_edit
         FROM tool_call t
         WHERE t.tool_name IN ('Edit','Write') AND t.file_path IS NOT NULL
           AND t.ts_call IS NOT NULL${w.sql}
         GROUP BY path
       ),
       committed AS (
         SELECT ${withoutWorktree("f.path")} AS path, coalesce(c.label, '(no remote)') AS repo,
                c.ts AS ts, c.kind AS kind
         FROM commit_file f JOIN repo_commit c ON c.sha = f.sha
       ),
       shipped AS (
         SELECT path, min(repo) AS repo, count(*) AS commits FROM committed GROUP BY path
       ),
       returned AS (
         SELECT path, min(ts) AS fixed_at FROM committed WHERE kind = 'fix' GROUP BY path
       )
       SELECT replace(e.path, ? || '/', '') AS file, s.repo AS repo, e.skill AS skill,
              e.edits AS edits, s.commits AS commits,
              cast(julianday('now') - julianday(e.last_edit) AS INTEGER) AS days_since
       FROM edited e
       JOIN shipped s ON s.path = e.path
       LEFT JOIN returned r ON r.path = e.path AND r.fixed_at > e.last_edit
       WHERE r.path IS NULL
       ORDER BY e.edits DESC, days_since DESC, e.path
       LIMIT 25`,
      [...w.params, homeOf(ctx)],
    );
    return {
      denominator:
        `${scalar(db, "SELECT count(*) AS n FROM repo_commit")} commits read from the repos on disk ` +
        `(${windowLine(ctx)}); a file needs an agent edit, a commit, and no fix commit coming back to it ` +
        "since; `edits` counts the agent edits behind it" +
        (records.length === 25 ? ", and the 25 most edited are shown" : ""),
      columns,
      rows: toRows(records, columns),
      note:
        (records.length === 0
          ? "no agent-edited file in this window shipped without a fix coming back to it. "
          : "A nomination, never a verdict: nobody coming back to a file is not evidence it is right, only that it was " +
            "not revisited. A fix committed without the conventional prefix is invisible here, a file is matched by path " +
            "so repos sharing a name collide, and a file still being worked on today will read as untested rather than sound. ") +
        claudeOnly(CLAUDE_EDITS),
    };
  },
};

export const fixes: Query = {
  name: "fixes",
  summary: "files an agent edited that a later fix commit had to come back to, by skill",
  window: "t.ts_call",
  run: (db, ctx) => {
    const columns = ["skill", "files", "later_fixed", "fixed_pct", "mean_days", "sessions"];
    const w = window("t.ts_call", ctx);
    const records = table(
      db,
      `WITH edited AS (
         SELECT t.session_id, coalesce(t.attribution_skill, '(no skill)') AS skill,
                s.cwd, t.file_path, max(t.ts_call) AS last_edit,
                s.last_seen_at AS session_end
         FROM tool_call t JOIN session s ON s.id = t.session_id
         WHERE t.tool_name IN ('Edit','Write') AND t.file_path IS NOT NULL
           AND t.ts_call IS NOT NULL AND s.cwd IS NOT NULL${w.sql}
         GROUP BY t.session_id, t.file_path, skill, s.last_seen_at
       ),
       verdict AS (
         SELECT e.*,
                (SELECT min(c.ts) FROM repo_commit c JOIN commit_file f ON f.sha = c.sha
                 WHERE f.path = e.file_path AND c.kind = 'fix'
                   AND c.ts > coalesce(e.session_end, e.last_edit)) AS fixed_at
         FROM edited e
       )
       SELECT skill, count(*) AS files,
              sum(fixed_at IS NOT NULL) AS later_fixed,
              round(100.0 * sum(fixed_at IS NOT NULL) / count(*), 1) AS fixed_pct,
              round(mean_days, 1) AS mean_days,
              count(DISTINCT session_id) AS sessions
       FROM (SELECT v.*,
                    avg(julianday(fixed_at) - julianday(last_edit))
                      OVER (PARTITION BY skill) AS mean_days
             FROM verdict v)
       GROUP BY skill
       ORDER BY fixed_pct DESC, files DESC, skill`,
      w.params,
    );
    const commits = scalar(db, "SELECT count(*) AS n FROM repo_commit");
    const fixCommits = scalar(db, "SELECT count(*) AS n FROM repo_commit WHERE kind = 'fix'");
    const edited = records.reduce((n, r) => n + Number(r.files ?? 0), 0);
    return {
      denominator:
        `${fixCommits} fix commits of ${commits} read from the repos on disk (${windowLine(ctx)}); ` +
        `every skill that edited one of ${edited} files is a row, and \`files\` is the base each rate stands on`,
      columns,
      rows: toRows(records, columns),
      note:
        (commits === 0
          ? "no commits read: the working directories in this corpus are gone or were never repos. `dim sync`. "
          : records.length === 0
            ? "no agent edit in this window has the file path, timestamp and session working directory a row needs. "
            : "A `fix:` commit naming a file is the repo's verdict that the file needed changing, not " +
              "proof the agent caused it — a fix may land on code it never wrote, and work nobody came " +
              "back to may still be wrong. `mean_days` covers only the files that were fixed. Matching is by conventional-commit type, so a fix committed without the " +
              "prefix is invisible here. ") + claudeOnly(CLAUDE_EDITS),
    };
  },
};

export const stale: Query = {
  name: "stale",
  summary: "how much the code a session touched has changed since it ran",
  usage: "dim q stale [id-prefix]",
  window: "s.last_seen_at",
  run: (db, ctx) => {
    const { arg } = ctx;
    const columns = ["session", "project", "ran", "files", "moved_pct", "commits_since", "days"];
    const w = window("s.last_seen_at", ctx);
    const records = table(
      db,
      `WITH touched AS (
         SELECT s.id, s.project, s.last_seen_at, t.file_path
         FROM tool_call t JOIN session s ON s.id = t.session_id
         WHERE t.tool_name IN ('Edit','Write') AND t.file_path IS NOT NULL
           AND s.parent_id IS NULL AND s.last_seen_at IS NOT NULL
           ${arg ? "AND s.id LIKE ? || '%'" : ""}${w.sql}
         GROUP BY s.id, t.file_path
       ),
       scored AS (
         SELECT u.id, u.project, u.last_seen_at, u.file_path,
                (SELECT count(*) FROM commit_file f JOIN repo_commit c ON c.sha = f.sha
                 WHERE f.path = u.file_path AND c.ts > u.last_seen_at) AS commits_after
         FROM touched u
       )
       SELECT substr(id, 1, 8) AS session,
              replace(coalesce(project, ''), ? || '/', '') AS project,
              substr(max(last_seen_at), 1, 10) AS ran,
              count(*) AS files,
              round(100.0 * sum(commits_after > 0) / count(*)) AS moved_pct,
              sum(commits_after) AS commits_since,
              cast(julianday('now') - julianday(max(last_seen_at)) AS INTEGER) AS days
       FROM scored
       GROUP BY id HAVING files >= 3
       ORDER BY moved_pct DESC, commits_since DESC LIMIT 30`,
      [...(arg ? [arg] : []), ...w.params, homeOf(ctx)],
    );
    const commits = scalar(db, "SELECT count(*) AS n FROM repo_commit");
    return {
      denominator:
        commits === 0
          ? "no commits read, so nothing can be scored"
          : `${commits} commits read (${windowLine(ctx)}); sessions that edited at least 3 files`,
      columns,
      rows: toRows(records, columns),
      note:
        (commits === 0
          ? "`dim sync` from a machine holding the repos; without commits there is no measure of movement. "
          : "`moved_pct` is the share of the files that have been committed to since, and `commits_since` how " +
            "often in total. Both are shown because neither is the score: the share says whether the session's " +
            "ground moved, the count how far. The per-repo gate `acolyte import` settled on is the count. " +
            "It measures the area, not the work: a file under constant edit moves whatever was done to it. " +
            "Read a high score as evidence that what this session concluded is about code that has changed, " +
            "never as evidence the session was wrong. ") + claudeOnly(CLAUDE_EDITS),
    };
  },
};

const PER_REPO = 3;

export const priorArt: Query = {
  name: "prior-art",
  summary: "where a path like this one already exists across the repos on disk, newest first",
  usage: 'dim q prior-art "<path fragment>"',
  spansHistory: true,
  window: null,
  run: (db, ctx) => {
    const columns = ["file", "repo", "commits", "days_since", "authors"];
    const fragment = ctx.arg ?? "";
    if (!fragment) {
      return {
        denominator: "no path given",
        columns,
        rows: [],
        note: 'name part of a path, as in `dim q prior-art ".github/workflows"` or `dim q prior-art Dockerfile`',
      };
    }

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
      [fragment, homeOf(ctx), homeOf(ctx)],
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

export const convention: Query = {
  name: "convention",
  summary: "the commit convention each repo's own log holds",
  usage: "dim q convention [repo-fragment]",
  spansHistory: true,
  window: "ts",
  run: (db, ctx) => {
    const { arg } = ctx;
    const columns = [
      "repo",
      "commits",
      "conventional_pct",
      "mean_len",
      "over_50_pct",
      "squashed_pct",
      "top_kinds",
    ];
    const conds: string[] = [];
    const filter: unknown[] = [];
    if (arg) {
      conds.push("repo_key LIKE '%' || ? || '%'");
      filter.push(arg);
    }
    const w = window("ts", ctx, "WHERE");
    if (w.sql) {
      conds.push(w.sql.trim().replace(/^WHERE /, ""));
      filter.push(...w.params);
    }
    const scope = { home: homeOf(ctx), conds, params: filter };
    const records = conventionRecords(db, scope, 30);
    const commits = conventionCommits(db, scope);
    return {
      denominator:
        commits === 0
          ? "no commits read, so no repo has a convention to report"
          : `${commits} commits read from the repos on disk (${windowLine(ctx)}); ` +
            `${records.length} of them have the ${CONVENTION_FLOOR} commits it takes to be reported, at most 30 shown`,
      columns,
      rows: toRows(records, columns),
      note:
        commits === 0
          ? "`dim sync` from a machine holding the repos"
          : "This is what a repo does, not what it should do: a repo that was cloned rather than written " +
            "reports its authors' convention, so read the repo column first. `squashed_pct` counts the `(#N)` " +
            "suffix a forge appends on a squash merge, so it is evidence of branching where it is high and " +
            "no evidence either way where it is low — a forge configured to omit it leaves no mark.",
    };
  },
};
