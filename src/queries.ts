import type { Database } from "bun:sqlite";

export type QueryResult = {
  /** Printed above the rows, so a number is never read without its base. */
  denominator: string;
  columns: string[];
  rows: (string | number | null)[][];
  /** Shown instead of an empty table, so no evidence never reads as a zero. */
  note?: string;
};

/**
 * `since` is an ISO timestamp the caller already resolved from `--since`. Old
 * sessions ran under guidance that has since been rewritten, so counting them
 * beside this week's describes a machine that no longer exists.
 */
export type QueryContext = { arg?: string; since?: string };

export type Query = {
  name: string;
  summary: string;
  usage?: string;
  /** A time series whose point is the arc across months, so no window is applied unless asked. */
  spansHistory?: boolean;
  run: (db: Database, ctx: QueryContext) => QueryResult;
};

/** The window as a bound fragment, empty when the caller asked for all of history. */
function window(
  col: string,
  ctx: QueryContext,
  keyword: "WHERE" | "AND" = "AND",
): { sql: string; params: string[] } {
  if (!ctx.since) return { sql: "", params: [] };
  return { sql: ` ${keyword} ${col} >= ?`, params: [ctx.since] };
}

const windowLine = (ctx: QueryContext): string =>
  ctx.since ? `since ${ctx.since.slice(0, 10)}` : "all time";

function scalar(db: Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as [])) as { n: number } | null;
  return row?.n ?? 0;
}

function table(db: Database, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  return db.prepare(sql).all(...(params as [])) as Record<string, unknown>[];
}

function toRows(records: Record<string, unknown>[], columns: string[]): (string | number | null)[][] {
  return records.map((r) => columns.map((c) => (r[c] ?? null) as string | number | null));
}

const corpusLine = (db: Database, ctx: QueryContext): string => {
  const w = window("last_seen_at", ctx, "WHERE");
  const sessions = scalar(db, `SELECT count(*) AS n FROM session${w.sql}`, ...w.params);
  const m = window("ts", ctx, "WHERE");
  const messages = scalar(db, `SELECT count(*) AS n FROM message${m.sql}`, ...m.params);
  const responses = scalar(db, `SELECT count(*) AS n FROM usage${m.sql}`, ...m.params);
  return `${sessions} sessions, ${messages} messages, ${responses} API responses (${windowLine(ctx)})`;
};

const tokens: Query = {
  name: "tokens",
  summary: "input, cache and output tokens per tool and model",
  run: (db, ctx) => {
    const columns = [
      "tool",
      "model",
      "responses",
      "input",
      "cache_read",
      "cache_write",
      "output",
      "reasoning",
    ];
    const w = window("u.ts", ctx, "WHERE");
    const records = table(
      db,
      `SELECT s.tool, coalesce(u.model, '(unnamed)') AS model, count(*) AS responses,
              sum(u.input_tokens) AS input, sum(u.cache_read_tokens) AS cache_read,
              sum(u.cache_write_tokens) AS cache_write, sum(u.output_tokens) AS output,
              sum(coalesce(u.reasoning_tokens, 0)) AS reasoning
       FROM usage u JOIN session s ON s.id = u.session_id${w.sql}
       GROUP BY s.tool, u.model ORDER BY responses DESC`,
      w.params,
    );
    return {
      denominator: `${corpusLine(db, ctx)}. One row per API response, deduplicated on the response id.`,
      columns,
      rows: toRows(records, columns),
      // The two tools count the same word differently; a combined total would be a
      // number with no meaning.
      note:
        records.length === 0
          ? "no usage rows"
          : "Claude excludes cached reads from input; Codex includes them. Not summed across tools.",
    };
  },
};

const models: Query = {
  name: "models",
  summary: "sessions, responses and tokens per model per month — descriptive only",
  spansHistory: true,
  run: (db, ctx) => {
    const columns = ["month", "tool", "model", "sessions", "responses", "output"];
    const w = window("u.ts", ctx, "WHERE");
    const records = table(
      db,
      `SELECT substr(u.ts, 1, 7) AS month, s.tool, coalesce(u.model, '(unnamed)') AS model,
              count(DISTINCT u.session_id) AS sessions, count(*) AS responses,
              sum(u.output_tokens) AS output
       FROM usage u JOIN session s ON s.id = u.session_id${w.sql}
       GROUP BY month, s.tool, u.model ORDER BY month DESC, responses DESC`,
      w.params,
    );
    return {
      denominator: corpusLine(db, ctx),
      columns,
      rows: toRows(records, columns),
      // Across these months the projects, the guidance and the habits all changed,
      // so a difference between two rows is not an effect of the model.
      note: "Descriptive. Nothing here compares models; the corpus has no arm held fixed.",
    };
  },
};

const cost: Query = {
  name: "cost",
  summary: "cost as each tool reported it, never derived here",
  spansHistory: true,
  run: (db, ctx) => {
    const columns = ["month", "sessions_reporting", "total_usd"];
    const w = window("coalesce(c.ts, s.started_at)", ctx, "WHERE");
    const records = table(
      db,
      `SELECT substr(coalesce(c.ts, s.started_at), 1, 7) AS month,
              count(*) AS sessions_reporting, round(sum(c.total_cost_usd), 2) AS total_usd
       FROM session_cost_reported c JOIN session s ON s.id = c.session_id${w.sql}
       GROUP BY month ORDER BY month DESC`,
      w.params,
    );
    const claudeSessions = scalar(db, "SELECT count(*) AS n FROM session WHERE tool = 'claude'");
    const reporting = scalar(db, "SELECT count(*) AS n FROM session_cost_reported");
    const codex = scalar(db, "SELECT count(*) AS n FROM session WHERE tool = 'codex'");
    return {
      denominator: `${reporting} of ${claudeSessions} Claude sessions carry a cost record; ${codex} Codex sessions report none (${windowLine(ctx)})`,
      columns,
      rows: toRows(records, columns),
      note:
        reporting === 0
          ? "no session reported a cost"
          : "Claude Code's own figure. This database holds no price table and derives no dollar amount.",
    };
  },
};

const turns: Query = {
  name: "turns",
  summary: "turn duration and how turns ended, per tool",
  run: (db, ctx) => {
    const columns = ["tool", "turns", "median_s", "p90_s", "interrupted", "interrupted_pct"];
    const records = table(
      db,
      `WITH t AS (SELECT s.tool, t.duration_ms, t.status,
                         row_number() OVER (PARTITION BY s.tool ORDER BY t.duration_ms) AS rn,
                         count(*) OVER (PARTITION BY s.tool) AS n
                  FROM turn t JOIN session s ON s.id = t.session_id
                  WHERE t.duration_ms IS NOT NULL${window("t.ts_end", ctx).sql})
       SELECT tool, max(n) AS turns,
              round(max(CASE WHEN rn = n / 2 THEN duration_ms END) / 1000.0, 1) AS median_s,
              round(max(CASE WHEN rn = n * 9 / 10 THEN duration_ms END) / 1000.0, 1) AS p90_s,
              sum(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END) AS interrupted,
              round(100.0 * sum(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END) / max(n), 1) AS interrupted_pct
       FROM t GROUP BY tool`,
      window("t.ts_end", ctx).params,
    );
    const w = window("ts_end", ctx, "WHERE");
    const all = scalar(db, `SELECT count(*) AS n FROM turn${w.sql}`, ...w.params);
    const timed = scalar(
      db,
      `SELECT count(*) AS n FROM turn WHERE duration_ms IS NOT NULL${window("ts_end", ctx).sql}`,
      ...w.params,
    );
    return {
      // The percentiles are computed only over turns that carry a duration, and
      // which turns those are is not random, so the gap is stated rather than
      // left for a reader to infer from a total that does not add up.
      denominator: `${timed} of ${all} turns carry a duration; the percentiles cover only those (${windowLine(ctx)})`,
      columns,
      rows: toRows(records, columns),
      note:
        "Claude records no turn status, so its interrupted count is not measured, not zero. " +
        "Codex rollouts before roughly March 2026 emit task_complete without started_at or " +
        "duration_ms, so their turns are counted but not timed; no duration is derived for them.",
    };
  },
};

const sessions: Query = {
  name: "sessions",
  summary: "most recently active sessions, newest first",
  run: (db, ctx) => {
    const columns = ["id", "tool", "project", "started", "turns", "responses", "output", "ended"];
    const records = table(
      db,
      `SELECT substr(s.id, 1, 8) AS id, s.tool,
              replace(coalesce(s.project, ''), '/Users/christofferniska/code/', '') AS project,
              substr(s.started_at, 1, 16) AS started,
              (SELECT count(*) FROM turn t WHERE t.session_id = s.id) AS turns,
              (SELECT count(*) FROM usage u WHERE u.session_id = s.id) AS responses,
              (SELECT sum(u.output_tokens) FROM usage u WHERE u.session_id = s.id) AS output,
              coalesce(s.end_reason, '') AS ended
       FROM session s WHERE s.parent_id IS NULL${window("s.last_seen_at", ctx).sql}
       ORDER BY s.last_seen_at DESC LIMIT 40`,
      window("s.last_seen_at", ctx).params,
    );
    const w = window("last_seen_at", ctx);
    const ended = scalar(
      db,
      `SELECT count(*) AS n FROM session WHERE end_reason IS NOT NULL${w.sql}`,
      ...w.params,
    );
    return {
      denominator: `${corpusLine(db, ctx)}; ${ended} sessions have an end reason from the hook spool`,
      columns,
      rows: toRows(records, columns),
      note:
        ended === 0
          ? "No session has an end reason: the hooks are not installed, so abandoned and open look alike. `dim install-hooks`."
          : undefined,
    };
  },
};

const session: Query = {
  name: "session",
  summary: "one session in full",
  usage: "dim q session <id-prefix>",
  spansHistory: true,
  run: (db, { arg }) => {
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [["usage: dim q session <id-prefix>"]] };
    }
    const found = table(
      db,
      `SELECT id, tool, project, git_branch, cli_version, entrypoint, started_at, last_seen_at,
              end_reason, first_model, last_model, title
       FROM session WHERE id LIKE ? || '%' LIMIT 2`,
      [arg],
    );
    if (found.length === 0) {
      return { denominator: "", columns: ["id"], rows: [], note: `no session starts with ${arg}` };
    }
    if (found.length > 1) {
      return { denominator: "", columns: ["id"], rows: [], note: `${arg} matches more than one session` };
    }
    const s = (found[0] ?? {}) as Record<string, string | null | undefined>;
    const id = s.id as string;
    const text = (v: string | null | undefined): string | null => v ?? null;
    const facts: [string, string | number | null][] = [
      ["tool", text(s.tool)],
      ["project", text(s.project)],
      ["branch", text(s.git_branch)],
      ["cli", text(s.cli_version)],
      ["entrypoint", text(s.entrypoint)],
      ["title", text(s.title)],
      ["started", text(s.started_at)],
      ["last seen", text(s.last_seen_at)],
      ["end reason", s.end_reason ?? "not recorded (no hook)"],
      ["models", [s.first_model, s.last_model].filter(Boolean).join(" → ") || null],
      ["messages", scalar(db, "SELECT count(*) AS n FROM message WHERE session_id = ?", id)],
      [
        "user prompts",
        scalar(
          db,
          "SELECT count(*) AS n FROM message WHERE session_id = ? AND role = 'user' AND prompt_source IN ('typed','queued')",
          id,
        ),
      ],
      ["responses", scalar(db, "SELECT count(*) AS n FROM usage WHERE session_id = ?", id)],
      [
        "output tokens",
        scalar(db, "SELECT coalesce(sum(output_tokens),0) AS n FROM usage WHERE session_id = ?", id),
      ],
      [
        "cache read",
        scalar(db, "SELECT coalesce(sum(cache_read_tokens),0) AS n FROM usage WHERE session_id = ?", id),
      ],
      ["turns", scalar(db, "SELECT count(*) AS n FROM turn WHERE session_id = ?", id)],
      [
        "interrupted turns",
        scalar(db, "SELECT count(*) AS n FROM turn WHERE session_id = ? AND status = 'interrupted'", id),
      ],
      [
        "user interruptions",
        scalar(
          db,
          "SELECT count(*) AS n FROM message WHERE session_id = ? AND interrupted_message_id IS NOT NULL",
          id,
        ),
      ],
      [
        "tool rejections",
        scalar(db, "SELECT count(*) AS n FROM message WHERE session_id = ? AND denial_kind IS NOT NULL", id),
      ],
      ["subagents", scalar(db, "SELECT count(*) AS n FROM session WHERE parent_id = ?", id)],
    ];
    return {
      denominator: `session ${id}`,
      columns: ["fact", "value"],
      rows: facts.map(([k, v]) => [k, v]),
    };
  },
};

const tools: Query = {
  name: "tools",
  summary: "tool call counts, failures and the read-to-edit ratio per tool",
  run: (db, ctx) => {
    const columns = ["tool", "tool_name", "calls", "failed", "failed_pct", "avg_result_bytes"];
    const records = table(
      db,
      `SELECT s.tool, t.tool_name, count(*) AS calls,
              sum(coalesce(t.is_error, 0)) AS failed,
              round(100.0 * sum(coalesce(t.is_error, 0)) / count(*), 1) AS failed_pct,
              CASE WHEN count(t.result_bytes) = 0 THEN NULL
                   ELSE round(avg(t.result_bytes)) END AS avg_result_bytes
       FROM tool_call t JOIN session s ON s.id = t.session_id${window("t.ts_call", ctx, "WHERE").sql}
       GROUP BY s.tool, t.tool_name ORDER BY calls DESC`,
      window("t.ts_call", ctx).params,
    );
    const w = window("ts_call", ctx);
    const noResult = scalar(
      db,
      `SELECT count(*) AS n FROM tool_call WHERE ts_result IS NULL${w.sql}`,
      ...w.params,
    );
    const calls = scalar(
      db,
      `SELECT count(*) AS n FROM tool_call${window("ts_call", ctx, "WHERE").sql}`,
      ...w.params,
    );
    return {
      denominator: `${calls} tool calls; ${noResult} have no result record (${windowLine(ctx)})`,
      columns,
      rows: toRows(records, columns),
      // Claude records no exit code, so a Claude failure is only what the
      // transcript marked is_error, not every command that returned non-zero.
      note: "Claude records no exit code; its failure count is what the transcript marked, not every non-zero exit.",
    };
  },
};

const skills: Query = {
  name: "skills",
  summary: "how often each skill loaded, by which path, and what its body cost",
  run: (db, ctx) => {
    const columns = [
      "skill",
      "loads",
      "model_chose",
      "user_typed",
      "file_read",
      "sessions",
      "body_chars",
      "versions",
      "calls_after",
    ];
    const records = table(
      db,
      // Every API response after a load re-reads that body from cache, so the
      // count of responses following a load is the honest unit of what an
      // instruction costs — counted per load, then summed.
      `WITH after AS (
         SELECT l.skill_name, count(*) AS calls_after
         FROM skill_load l JOIN usage u ON u.session_id = l.session_id AND u.ts > l.ts
         ${window("l.ts", ctx, "WHERE").sql}
         GROUP BY l.skill_name
       )
       SELECT l.skill_name AS skill, count(*) AS loads,
              sum(l.how = 'model') AS model_chose,
              sum(l.how = 'user') AS user_typed,
              sum(l.how = 'read') AS file_read,
              count(DISTINCT l.session_id) AS sessions,
              CASE WHEN count(l.body_chars) = 0 THEN NULL
                   ELSE round(avg(l.body_chars)) END AS body_chars,
              count(DISTINCT l.body_sha256) AS versions,
              coalesce(a.calls_after, 0) AS calls_after
       FROM skill_load l LEFT JOIN after a ON a.skill_name = l.skill_name
       ${window("l.ts", ctx, "WHERE").sql}
       GROUP BY l.skill_name ORDER BY loads DESC`,
      [...window("l.ts", ctx).params, ...window("l.ts", ctx).params],
    );
    const w = window("ts", ctx);
    const withBody = scalar(
      db,
      `SELECT count(*) AS n FROM skill_load WHERE body_chars IS NOT NULL${w.sql}`,
      ...w.params,
    );
    const all = scalar(
      db,
      `SELECT count(*) AS n FROM skill_load${window("ts", ctx, "WHERE").sql}`,
      ...w.params,
    );
    const named = scalar(
      db,
      `SELECT count(DISTINCT skill_name) AS n FROM skill_load${window("ts", ctx, "WHERE").sql}`,
      ...w.params,
    );
    return {
      denominator: `${all} loads across ${named} skills; ${withBody} carry a measured body (${windowLine(ctx)})`,
      columns,
      rows: toRows(records, columns),
      note:
        all === 0
          ? "no skill load recorded"
          : "A skill absent here never loaded in this corpus, which is a fact about the corpus, not a verdict on the skill. " +
            "Only Claude injects a body the size of which can be measured; a Codex file read is counted but not sized.",
    };
  },
};

/**
 * A correction is credited to the attribution_skill of the assistant message
 * immediately before it, and an unattributed message clears the credit. Carrying
 * the last-seen skill forward blames whichever skill ran most recently for
 * everything that follows and inflates the rate of rarely used ones.
 */
const attributed = (ctx: QueryContext): string => `
  SELECT m.id, m.session_id, m.ts, m.model, m.text, m.denial_kind, m.user_feedback,
         m.interrupted_message_id,
         (SELECT p.attribution_skill FROM message p
          WHERE p.session_id = m.session_id AND p.role = 'assistant' AND p.ts <= m.ts
          ORDER BY p.ts DESC, p.src_line DESC LIMIT 1) AS skill
  FROM message m
  WHERE m.role = 'user'
    AND (m.denial_kind = 'user-rejected' OR m.interrupted_message_id IS NOT NULL
         OR m.user_feedback IS NOT NULL)${window("m.ts", ctx).sql}`;

const corrections: Query = {
  name: "corrections",
  summary: "the mechanical signals that the user stopped the agent, by skill",
  run: (db, ctx) => {
    const { arg } = ctx;
    const columns = ["skill", "rejected", "interrupted", "with_feedback", "labeled", "sessions"];
    const w = window("m.ts", ctx);
    const records = table(
      db,
      `WITH c AS (${attributed(ctx)})
       SELECT coalesce(c.skill, '(unattributed)') AS skill,
              sum(c.denial_kind IS NOT NULL) AS rejected,
              sum(c.interrupted_message_id IS NOT NULL) AS interrupted,
              sum(c.user_feedback IS NOT NULL) AS with_feedback,
              (SELECT count(*) FROM correction_label cl
               JOIN message m2 ON m2.id = cl.message_id
               WHERE cl.label = 'correction'
                 AND coalesce((SELECT p.attribution_skill FROM message p
                               WHERE p.session_id = m2.session_id AND p.role = 'assistant'
                                 AND p.ts <= m2.ts ORDER BY p.ts DESC LIMIT 1), '(unattributed)')
                     = coalesce(c.skill, '(unattributed)')) AS labeled,
              count(DISTINCT c.session_id) AS sessions
       FROM c ${arg ? "WHERE c.skill = ?" : ""}
       GROUP BY c.skill ORDER BY rejected + interrupted DESC`,
      [...w.params, ...(arg ? [arg] : [])],
    );
    const labeled = scalar(db, "SELECT count(*) AS n FROM correction_label");
    const candidates = scalar(db, `WITH c AS (${attributed(ctx)}) SELECT count(*) AS n FROM c`, ...w.params);
    return {
      denominator: `${candidates} turns the user physically stopped; ${labeled} have been labeled by hand (${windowLine(ctx)})`,
      columns,
      rows: toRows(records, columns),
      note:
        candidates === 0
          ? "no rejection, interruption or written feedback in the corpus"
          : "These are acts the tool recorded, not judgements. Whether a prompt told the agent it was " +
            "wrong is semantic and nothing here decides it; `dim label` records the owner's call. " +
            "An unlabeled candidate is never counted as a correction.",
    };
  },
};

/**
 * A file edited repeatedly is not evidence of anything on its own — writing a
 * file in pieces looks identical to fixing it three times. What separates them
 * is whether the user pushed back between the edits, which the transcript
 * records as an act rather than a judgement.
 */
const rework: Query = {
  name: "rework",
  summary: "files the agent had to revisit after you pushed back, by skill",
  run: (db, ctx) => {
    const { arg } = ctx;
    const columns = ["skill", "files_touched", "revisited", "after_pushback", "pushback_rate"];
    const records = table(
      db,
      `WITH spans AS (
         SELECT t.session_id, t.file_path,
                coalesce(t.attribution_skill, '(no skill)') AS skill,
                min(t.ts_call) AS first_edit, max(t.ts_call) AS last_edit,
                count(*) AS edits
         FROM tool_call t
         WHERE t.tool_name IN ('Edit','Write') AND t.file_path IS NOT NULL AND t.ts_call IS NOT NULL${window("t.ts_call", ctx).sql}
         GROUP BY t.session_id, t.file_path, skill
       ),
       marked AS (
         SELECT s.*,
                (SELECT count(*) FROM message m
                 WHERE m.session_id = s.session_id
                   AND m.ts > s.first_edit AND m.ts <= s.last_edit
                   AND (m.denial_kind IS NOT NULL OR m.interrupted_message_id IS NOT NULL
                        OR m.user_feedback IS NOT NULL)) AS stops
         FROM spans s
       )
       SELECT skill,
              count(*) AS files_touched,
              sum(edits > 1) AS revisited,
              sum(edits > 1 AND stops > 0) AS after_pushback,
              round(100.0 * sum(edits > 1 AND stops > 0) / count(*), 1) AS pushback_rate
       FROM marked
       ${arg ? "WHERE skill = ?" : ""}
       GROUP BY skill HAVING files_touched >= 20
       ORDER BY pushback_rate DESC`,
      [...window("t.ts_call", ctx).params, ...(arg ? [arg] : [])],
    );
    const w = window("ts_call", ctx);
    const total = scalar(
      db,
      `SELECT count(*) AS n FROM tool_call
       WHERE tool_name IN ('Edit','Write') AND file_path IS NOT NULL${w.sql}`,
      ...w.params,
    );
    return {
      denominator: `${total} file edits; rows shown only where a skill touched at least 20 files (${windowLine(ctx)})`,
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? "no skill has touched enough files to report a rate"
          : "`after_pushback` counts a file revisited while the user was stopping the agent. It is a " +
            "co-occurrence, not a cause: a skill loads because the task is a certain kind. Read it as " +
            "where to look, never as which skill is worse.",
    };
  },
};

/**
 * Every term is quoted before it reaches FTS5, which otherwise reads `-` as NOT
 * and `:` as a column filter — so a branch name or a flag searches as the word
 * it is. Terms are ANDed; the query language is not exposed.
 */
const asPhrases = (terms: string): string =>
  terms
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(" ");

/**
 * What was said, not what was counted. The alternative is grepping every
 * transcript on disk, which reads whole tool results and file contents back out
 * of megabyte files to find one sentence.
 */
const search: Query = {
  name: "search",
  summary: "find a past message by its words, newest first",
  usage: 'dim q search "<terms>"',
  spansHistory: true,
  run: (db, ctx) => {
    const { arg } = ctx;
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [['usage: dim q search "<terms>"']] };
    }
    const columns = ["session", "when", "role", "project", "text"];
    const w = window("m.ts", ctx);
    const records = table(
      db,
      `SELECT substr(m.session_id, 1, 8) AS session, substr(m.ts, 1, 16) AS "when", m.role,
              replace(coalesce(s.project, ''), '/Users/christofferniska/code/', '') AS project,
              replace(snippet(message_fts, 0, '[', ']', '…', 12), char(10), ' ') AS text
       FROM message_fts
       JOIN message m ON m.rowid = message_fts.rowid
       JOIN session s ON s.id = m.session_id
       WHERE message_fts MATCH ?${w.sql}
       ORDER BY m.ts DESC LIMIT 40`,
      [asPhrases(arg), ...w.params],
    );
    const indexed = scalar(db, "SELECT count(*) AS n FROM message WHERE text IS NOT NULL");
    const all = scalar(db, "SELECT count(*) AS n FROM message");
    return {
      denominator: `${indexed} of ${all} messages carry text and are searchable (${windowLine(ctx)}); newest 40 shown`,
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? `nothing matches ${arg}; a message with no text is a tool call or its result, which this index does not hold`
          : undefined,
    };
  },
};

/**
 * The sentence that settled a question is rarely the one that matched, so a hit
 * is only useful with its neighbours. Skill bodies and injected meta are left
 * out: they are the largest text in a session and none of it was said by anyone.
 */
const thread: Query = {
  name: "thread",
  summary: "read one session's exchange, or the messages around a timestamp",
  usage: "dim q thread <id-prefix>[@<ts>]",
  spansHistory: true,
  run: (db, { arg }) => {
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [["usage: dim q thread <id-prefix>[@<ts>]"]] };
    }
    const [prefix, at] = arg.split("@");
    const found = table(db, "SELECT id FROM session WHERE id LIKE ? || '%' LIMIT 2", [prefix]);
    if (found.length === 0) {
      return { denominator: "", columns: ["id"], rows: [], note: `no session starts with ${prefix}` };
    }
    if (found.length > 1) {
      return { denominator: "", columns: ["id"], rows: [], note: `${prefix} matches more than one session` };
    }
    const id = found[0]?.id as string;
    const columns = ["when", "role", "skill", "text"];
    const said = `FROM message WHERE session_id = ? AND text IS NOT NULL
                  AND is_skill_body = 0 AND is_meta = 0`;
    const select = `SELECT substr(ts, 1, 16) AS "when", role,
                           coalesce(attribution_skill, '') AS skill,
                           replace(substr(text, 1, 240), char(10), ' ') AS text, ts`;
    const records = at
      ? table(
          db,
          `SELECT * FROM (
             SELECT * FROM (${select} ${said} AND ts <= ? ORDER BY ts DESC LIMIT 12)
             UNION
             SELECT * FROM (${select} ${said} AND ts > ? ORDER BY ts ASC LIMIT 12)
           ) ORDER BY ts`,
          [id, at, id, at],
        )
      : table(db, `${select} ${said} ORDER BY ts LIMIT 40`, [id]);
    const all = scalar(db, `SELECT count(*) AS n ${said}`, id);
    return {
      denominator: `session ${id}: ${all} messages anyone said${at ? `, centered on ${at}` : ""}`,
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? "nothing was said in this session outside tool calls and injected text"
          : "Text is cut at 240 characters. Tool calls, their results, skill bodies and injected meta are not here.",
    };
  },
};

export const QUERIES: Query[] = [
  search,
  thread,
  tokens,
  models,
  cost,
  turns,
  tools,
  skills,
  corrections,
  rework,
  sessions,
  session,
];

export function findQuery(name: string): Query | undefined {
  return QUERIES.find((q) => q.name === name);
}
