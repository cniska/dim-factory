import type { Database } from "bun:sqlite";
import { fromBlob, type Question, similarity } from "./embed";
import { withoutWorktree } from "./worktree";

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
export type QueryContext = {
  arg?: string;
  since?: string;
  home?: string;
  /** Resolved by the caller, as `since` is, so no query has to be async to rank by meaning. */
  question?: Question;
};

/**
 * Paths print relative to the reader's home, so the project column stays short
 * on any machine. Bound rather than written into the SQL: another person's
 * corpus sits under a different home, and a literal there is a fact about mine.
 */
const homeOf = (ctx: QueryContext): string => ctx.home ?? "";

export type Query = {
  name: string;
  summary: string;
  usage?: string;
  /** A time series whose point is the arc across months, so no window is applied unless asked. */
  spansHistory?: boolean;
  /** Its argument is a question to rank by meaning, which the caller resolves into `ctx.question`. */
  embedsArg?: boolean;
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

/**
 * Goal 2 is that work does not stop, and a usage limit is measured over a
 * rolling window rather than a day. This reports the rate in that shape: what
 * each tool spent per five-hour block, against what it changed in the same
 * block. No limit, quota or refusal is recorded anywhere in the corpus, so the
 * question it answers is not how close a block came to stopping but how much
 * spend a block turned into edits — which is comparable between blocks without
 * knowing any cap.
 */
const burn: Query = {
  name: "burn",
  summary: "spend against edits per rolling five-hour block — how much a block turned into changes",
  run: (db, ctx) => {
    const columns = ["block", "tool", "sessions", "responses", "edits", "cache_read", "output"];
    const w = window("u.ts", ctx, "WHERE");
    const records = table(
      db,
      `WITH spend AS (
         SELECT datetime((strftime('%s', u.ts) / 18000) * 18000, 'unixepoch') AS block,
                s.tool AS tool, count(DISTINCT u.session_id) AS sessions, count(*) AS responses,
                sum(u.cache_read_tokens) AS cache_read, sum(u.output_tokens) AS output
         FROM usage u JOIN session s ON s.id = u.session_id${w.sql}
         GROUP BY block, tool
       ), changed AS (
         SELECT datetime((strftime('%s', t.ts_call) / 18000) * 18000, 'unixepoch') AS block,
                s.tool AS tool, count(*) AS edits
         FROM tool_call t JOIN session s ON s.id = t.session_id
         WHERE t.ts_call IS NOT NULL AND t.tool_name IN ('Edit', 'Write', 'FileChange')
         GROUP BY block, tool
       )
       SELECT spend.block AS block, spend.tool AS tool, spend.sessions AS sessions,
              spend.responses AS responses, coalesce(changed.edits, 0) AS edits,
              spend.cache_read AS cache_read, spend.output AS output
       FROM spend LEFT JOIN changed ON changed.block = spend.block AND changed.tool = spend.tool
       ORDER BY spend.block DESC, spend.responses DESC`,
      w.params,
    );
    return {
      denominator: `${corpusLine(db, ctx)}. Blocks are five hours wide, aligned to the epoch, not to when a window opened.`,
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? "no usage rows"
          : "No limit, quota or refusal is recorded here, so nothing in this says how close a block came to stopping. " +
            "An edit is a file written, not work finished — a block of reading, or one long correct change, reads as thin " +
            "against a block that rewrote the same file ten times. The two tools count a cached read differently, so no row is summed across them.",
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
              replace(coalesce(s.project, ''), ? || '/', '') AS project,
              substr(s.started_at, 1, 16) AS started,
              (SELECT count(*) FROM turn t WHERE t.session_id = s.id) AS turns,
              (SELECT count(*) FROM usage u WHERE u.session_id = s.id) AS responses,
              (SELECT sum(u.output_tokens) FROM usage u WHERE u.session_id = s.id) AS output,
              coalesce(s.end_reason, '') AS ended
       FROM session s WHERE s.parent_id IS NULL${window("s.last_seen_at", ctx).sql}
       ORDER BY s.last_seen_at DESC LIMIT 40`,
      [homeOf(ctx), ...window("s.last_seen_at", ctx).params],
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
 * The candidates themselves, so a judgement can be made by reading rather than
 * from a count. Labeled rows are left out: the list is work remaining, and one
 * already judged is not work.
 */
const candidates: Query = {
  name: "candidates",
  summary: "unlabeled turns the user stopped, with enough text to judge them",
  usage: "dim q candidates [skill]",
  run: (db, ctx) => {
    const { arg } = ctx;
    const columns = ["message_id", "when", "skill", "kind", "text"];
    const w = window("m.ts", ctx);
    const records = table(
      db,
      `WITH c AS (${attributed(ctx)})
       SELECT c.id AS message_id, substr(c.ts, 1, 16) AS "when",
              coalesce(c.skill, '(none)') AS skill,
              CASE WHEN c.denial_kind IS NOT NULL THEN 'rejected'
                   WHEN c.interrupted_message_id IS NOT NULL THEN 'interrupted'
                   ELSE 'feedback' END AS kind,
              replace(substr(coalesce(c.user_feedback, c.text, ''), 1, 200), char(10), ' ') AS text
       FROM c
       WHERE c.id NOT IN (SELECT message_id FROM correction_label)
         ${arg ? "AND c.skill = ?" : ""}
       ORDER BY c.ts DESC LIMIT 20`,
      [...w.params, ...(arg ? [arg] : [])],
    );
    const labeled = scalar(db, "SELECT count(*) AS n FROM correction_label");
    const total = scalar(db, `WITH c AS (${attributed(ctx)}) SELECT count(*) AS n FROM c`, ...w.params);
    return {
      denominator: `${total} candidates in this window (${windowLine(ctx)}); ${labeled} labeled so far, newest 20 unlabeled shown`,
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? total === 0
            ? "no rejection, interruption or written feedback in this window"
            : "every candidate in this window has been labeled"
          : "A stop is an act, not a verdict: an interruption can be a correction, a change of mind, or " +
            "a faster idea. Read the text, then `dim label <message_id> <correction|clarification|not_correction>`. " +
            "Nothing here labels itself.",
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

/** What answers when the distilled index cannot: every message, but only the words actually typed. */
function keywordSearch(db: Database, ctx: QueryContext, terms: string, why: string): QueryResult {
  const columns = ["session", "when", "role", "project", "text"];
  const w = window("m.ts", ctx);
  const records = table(
    db,
    `SELECT substr(m.session_id, 1, 8) AS session, substr(m.ts, 1, 16) AS "when", m.role,
            replace(coalesce(s.project, ''), ? || '/', '') AS project,
            replace(snippet(message_fts, 0, '[', ']', '…', 12), char(10), ' ') AS text
     FROM message_fts
     JOIN message m ON m.rowid = message_fts.rowid
     JOIN session s ON s.id = m.session_id
     WHERE message_fts MATCH ?${w.sql}
     ORDER BY m.ts DESC LIMIT 40`,
    [homeOf(ctx), asPhrases(terms), ...w.params],
  );
  const indexed = scalar(db, "SELECT count(*) AS n FROM message WHERE text IS NOT NULL");
  const all = scalar(db, "SELECT count(*) AS n FROM message");
  return {
    denominator:
      `keywords over ${indexed} of ${all} messages that carry text (${windowLine(ctx)}); newest 40 shown. ` +
      `Meaning was not ranked: ${why}`,
    columns,
    rows: toRows(records, columns),
    note:
      records.length === 0
        ? `nothing matches ${terms}; a message with no text is a tool call or its result, which this index does not hold`
        : undefined,
  };
}

const SEMANTIC_HITS = 20;
const SNIPPET_CHARS = 96;
const PLACE_CHARS = 30;

const snippet = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SNIPPET_CHARS ? `${line.slice(0, SNIPPET_CHARS - 1)}…` : line;
};

/**
 * A commit from a scratch tree has no remote to name it, so its place is an
 * absolute path that is mostly temp directory. Kept from the right, where the
 * part that identifies it is, because every row pads to the widest cell.
 */
const place = (value: string | null): string | null => {
  if (value === null || value.length <= PLACE_CHARS) return value;
  return `…${value.slice(value.length - (PLACE_CHARS - 1))}`;
};

// Asked of sqlite_master rather than found by catching an error: a reader opens
// read-only, so a database older than the table cannot be given one.
const hasEmbeddings = (db: Database): boolean =>
  scalar(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'embedding'") > 0;

/**
 * A question and the passage answering it routinely share no words, which is the
 * one thing keywords cannot be made to do. Falls back rather than failing, in
 * the three ways this can break: nothing embedded, no model, no table.
 */
const search: Query = {
  name: "search",
  summary: "find a distilled passage by meaning, falling back to keywords",
  usage: 'dim q search "<question>"',
  spansHistory: true,
  embedsArg: true,
  run: (db, ctx) => {
    const { arg, question } = ctx;
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [['usage: dim q search "<question>"']] };
    }
    if (!question) throw new Error("search ranks by meaning, so the caller must resolve ctx.question");
    if (!hasEmbeddings(db)) {
      return keywordSearch(db, ctx, arg, "this database predates the embedding index; run `dim embed`");
    }
    if ("unavailable" in question) return keywordSearch(db, ctx, arg, question.unavailable);

    const w = window("coalesce(m.ts, c.ts)", ctx, "WHERE");
    const rows = db
      .prepare<{ kind: string; ref: string; vector: Uint8Array }, string[]>(
        `SELECT e.kind, e.ref, e.vector
         FROM embedding e
         LEFT JOIN message m ON e.kind <> 'subject' AND m.id = e.ref
         LEFT JOIN repo_commit c ON e.kind = 'subject' AND c.sha = e.ref${w.sql}`,
      )
      .all(...w.params);
    if (rows.length === 0) {
      return keywordSearch(db, ctx, arg, "nothing is embedded in this window; run `dim embed`");
    }

    const scored = rows
      .map((row) => ({
        kind: row.kind,
        ref: row.ref,
        score: similarity(question.vector, fromBlob(row.vector)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, SEMANTIC_HITS);

    const detail = db.prepare<
      { text: string; when: string | null; ref: string | null; place: string | null },
      [string, string, string, string]
    >(
      `SELECT e.text AS text, substr(coalesce(m.ts, c.ts), 1, 16) AS "when",
              substr(coalesce(m.session_id, e.ref), 1, 8) AS ref,
              coalesce(replace(s.project, ? || '/', ''), c.label, replace(c.repo, ? || '/', '')) AS place
       FROM embedding e
       LEFT JOIN message m ON e.kind <> 'subject' AND m.id = e.ref
       LEFT JOIN session s ON s.id = m.session_id
       LEFT JOIN repo_commit c ON e.kind = 'subject' AND c.sha = e.ref
       WHERE e.kind = ? AND e.ref = ?`,
    );

    const columns = ["score", "kind", "when", "ref", "where", "text"];
    const records = scored.map((hit) => {
      const row = detail.get(homeOf(ctx), homeOf(ctx), hit.kind, hit.ref);
      return {
        score: Number(hit.score.toFixed(3)),
        kind: hit.kind,
        when: row?.when ?? null,
        ref: row?.ref ?? hit.ref.slice(0, 8),
        where: place(row?.place ?? null),
        text: snippet(row?.text ?? ""),
      };
    });

    const byKind = table(db, "SELECT kind, count(*) AS n FROM embedding GROUP BY kind ORDER BY kind")
      .map((r) => `${r.n} ${r.kind}`)
      .join(", ");
    return {
      denominator:
        `cosine over ${rows.length} distilled passages in this window, of ${byKind} embedded ` +
        `(${windowLine(ctx)}); the ${records.length} closest shown`,
      columns,
      rows: toRows(records as unknown as Record<string, unknown>[], columns),
      note:
        "Meaning, not words: a hit need share no term with the question, and a low score is still the " +
        "closest thing indexed rather than an answer. This index holds text a person distilled — a " +
        "handoff's Next, a subject they authored, a prompt they labeled a correction — and no raw " +
        "conversation turn, so a sentence said in passing is not in it. `dim q thread <ref>` reads the " +
        "session a next or a correction came from.",
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

/**
 * One skill, split at each edit to its body. A correction is tied to the version
 * that was loaded in its session at the time, not to the version loaded today,
 * so rewriting a skill does not retroactively take credit for what the old text
 * did. Versions are ordered oldest first: the question is what changed.
 */
const skill: Query = {
  name: "skill",
  summary: "one skill, version by version: loads, size, and what got stopped under each",
  usage: "dim q skill <name>",
  spansHistory: true,
  run: (db, ctx) => {
    const { arg } = ctx;
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [["usage: dim q skill <name>"]] };
    }
    const columns = ["version", "first_seen", "last_seen", "loads", "sessions", "body_chars", "stopped"];
    const w = window("l.ts", ctx);
    const records = table(
      db,
      `WITH loads AS (
         SELECT l.session_id, l.ts, l.body_sha256, l.body_chars
         FROM skill_load l WHERE l.skill_name = ?${w.sql}
       ),
       stops AS (
         SELECT (SELECT ld.body_sha256 FROM loads ld
                 WHERE ld.session_id = m.session_id AND ld.ts <= m.ts
                 ORDER BY ld.ts DESC LIMIT 1) AS body_sha256
         FROM message m
         WHERE m.role = 'user'
           AND (m.denial_kind IS NOT NULL OR m.interrupted_message_id IS NOT NULL
                OR m.user_feedback IS NOT NULL)
           AND (SELECT p.attribution_skill FROM message p
                WHERE p.session_id = m.session_id AND p.role = 'assistant' AND p.ts <= m.ts
                ORDER BY p.ts DESC, p.src_line DESC LIMIT 1) = ?
       )
       SELECT coalesce(substr(l.body_sha256, 1, 8), '(unmeasured)') AS version,
              substr(min(l.ts), 1, 10) AS first_seen,
              substr(max(l.ts), 1, 10) AS last_seen,
              count(*) AS loads,
              count(DISTINCT l.session_id) AS sessions,
              max(l.body_chars) AS body_chars,
              (SELECT count(*) FROM stops s
               WHERE coalesce(s.body_sha256, '') = coalesce(l.body_sha256, '')) AS stopped
       FROM loads l
       GROUP BY l.body_sha256 ORDER BY min(l.ts)`,
      [arg, ...w.params, arg],
    );
    const known = scalar(db, "SELECT count(*) AS n FROM skill_load WHERE skill_name = ?", arg);
    // A version edited between two sessions is its own arm of one, and a column of
    // ones invites a comparison the sample cannot carry. The count leads so the
    // reader meets it before the table.
    const singles = records.filter((r) => Number(r.sessions) === 1).length;
    const unmeasured = records.some((r) => r.version === "(unmeasured)");
    return {
      denominator:
        `${arg}: ${known} loads in the corpus, ${records.length} versions in this window ` +
        `(${windowLine(ctx)})` +
        (records.length > 0 ? `; ${singles} of them were loaded in a single session` : ""),
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? `no load of ${arg} recorded; \`dim q skills\` names the skills that have loaded`
          : "`stopped` counts acts the tool recorded — a rejection, an interruption, written feedback — " +
            "under the version loaded at the time, never a judgement that the skill was wrong. Versions " +
            "differ in the tasks they met as well as in their text, so read a change as where to look." +
            (unmeasured
              ? " `(unmeasured)` is every load that reported no body: Codex reads the file itself, so its " +
                "loads carry no hash and fall together in one row rather than splitting by version."
              : ""),
    };
  },
};

/**
 * The facts a cold start needs, so a handoff spends its lines on the next move
 * instead of reconstructing the last one. Everything here is read from the
 * database rather than recalled: the session writing a handoff is usually the
 * one whose context is nearly full, which is exactly when recall is worst.
 */
const resume: Query = {
  name: "resume",
  summary: "the factual half of a handoff: branch, files in play, last pushback, last exchange",
  usage: "dim q resume <id-prefix>",
  spansHistory: true,
  run: (db, { arg }) => {
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [["usage: dim q resume <id-prefix>"]] };
    }
    const found = table(
      db,
      "SELECT id, project, git_branch, last_seen_at FROM session WHERE id LIKE ? || '%' LIMIT 2",
      [arg],
    );
    if (found.length === 0) {
      return { denominator: "", columns: ["what"], rows: [], note: `no session starts with ${arg}` };
    }
    if (found.length > 1) {
      return { denominator: "", columns: ["what"], rows: [], note: `${arg} matches more than one session` };
    }
    const s = found[0] as Record<string, string | null>;
    const id = s.id as string;
    const rows: (string | number | null)[][] = [
      ["branch", s.git_branch ?? "(none recorded)"],
      ["project", s.project ?? "(none recorded)"],
      ["last active", s.last_seen_at ?? null],
    ];

    // Ordered by the last touch, not the count: the file being worked on when the
    // session stopped is the one the next move starts from.
    for (const f of table(
      db,
      `SELECT file_path, count(*) AS edits, max(ts_call) AS last_edit
       FROM tool_call
       WHERE session_id = ? AND tool_name IN ('Edit','Write') AND file_path IS NOT NULL
       GROUP BY file_path ORDER BY last_edit DESC LIMIT 8`,
      [id],
    )) {
      rows.push(["edited", `${f.file_path} (${f.edits})`]);
    }

    for (const f of table(
      db,
      `SELECT tool_name, count(*) AS failures FROM tool_call
       WHERE session_id = ? AND is_error = 1 GROUP BY tool_name ORDER BY failures DESC LIMIT 3`,
      [id],
    )) {
      rows.push(["failed", `${f.tool_name} × ${f.failures}`]);
    }

    for (const p of table(
      db,
      `SELECT substr(ts, 1, 16) AS ts, replace(substr(coalesce(user_feedback, text, ''), 1, 160), char(10), ' ') AS said
       FROM message
       WHERE session_id = ? AND role = 'user'
         AND (denial_kind IS NOT NULL OR interrupted_message_id IS NOT NULL OR user_feedback IS NOT NULL)
       ORDER BY ts DESC LIMIT 3`,
      [id],
    )) {
      rows.push(["stopped", `${p.ts} ${p.said}`]);
    }

    for (const m of table(
      db,
      `SELECT * FROM (
         SELECT substr(ts, 1, 16) AS ts, role,
                replace(substr(text, 1, 200), char(10), ' ') AS said
         FROM message
         WHERE session_id = ? AND text IS NOT NULL AND is_skill_body = 0 AND is_meta = 0
         ORDER BY ts DESC LIMIT 6
       ) ORDER BY ts`,
      [id],
    )) {
      rows.push(["said", `${m.ts} ${m.role}: ${m.said}`]);
    }

    return {
      denominator: `session ${id}`,
      columns: ["what", "detail"],
      rows,
      note:
        "Facts only. What the next move should be is not in here — that is the judgement a handoff exists " +
        "to make. Run `dim sync` first if the session is still open, since only written bytes are read.",
    };
  },
};

/**
 * Who hands work off, and how much the delegate actually did. A spawn is cheap
 * to count and tells you nothing on its own: the question is whether the work
 * came back, which is the delegate's own output, and whether the parent was
 * stopped after it landed.
 */
const delegation: Query = {
  name: "delegation",
  summary: "work handed to a subagent or a peer, by the skill that handed it over",
  run: (db, ctx) => {
    const columns = ["skill", "handoffs", "subagents", "subagent_output", "failed", "sessions"];
    const w = window("t.ts_call", ctx, "WHERE");
    const records = table(
      db,
      `WITH handoff AS (
         SELECT t.session_id, coalesce(t.attribution_skill, '(no skill)') AS skill,
                t.tool_name, t.is_error
         FROM tool_call t
         WHERE t.tool_name IN ('Agent', 'SendMessage')${window("t.ts_call", ctx).sql}
       ),
       parents AS (SELECT DISTINCT session_id, skill FROM handoff WHERE tool_name = 'Agent'),
       kids AS (
         SELECT p.skill, count(DISTINCT c.id) AS subagents,
                coalesce(sum(u.output_tokens), 0) AS subagent_output
         FROM parents p
         JOIN session c ON c.parent_id = p.session_id
         LEFT JOIN usage u ON u.session_id = c.id
         GROUP BY p.skill
       )
       SELECT h.skill, count(*) AS handoffs,
              coalesce(k.subagents, 0) AS subagents,
              coalesce(k.subagent_output, 0) AS subagent_output,
              sum(coalesce(h.is_error, 0)) AS failed,
              count(DISTINCT h.session_id) AS sessions
       FROM handoff h LEFT JOIN kids k ON k.skill = h.skill
       GROUP BY h.skill ORDER BY handoffs DESC`,
      w.params,
    );
    const spawned = scalar(
      db,
      `SELECT count(*) AS n FROM tool_call t WHERE t.tool_name = 'Agent'${window("t.ts_call", ctx).sql}`,
      ...w.params,
    );
    const messaged = scalar(
      db,
      `SELECT count(*) AS n FROM tool_call t WHERE t.tool_name = 'SendMessage'${window("t.ts_call", ctx).sql}`,
      ...w.params,
    );
    const children = scalar(db, "SELECT count(*) AS n FROM session WHERE parent_id IS NOT NULL");
    return {
      denominator:
        `${spawned} agents spawned and ${messaged} messages sent to a peer in this window ` +
        `(${windowLine(ctx)}); ${children} subagent sessions recorded in the corpus`,
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? "nothing was handed to a subagent or a peer in this window"
          : "`subagents` and `subagent_output` count every child of a session that skill ever delegated " +
            "in, not only the children of these calls, so they are the scale of the delegation a skill " +
            "sits alongside rather than a per-call figure. A peer's own session is not a child and its " +
            "output is not counted here.",
    };
  },
};

/**
 * What is happening right now, including inside a subagent. Fanning work out
 * costs the visibility of watching it, and a transcript is written as it goes:
 * the delegate's own lines are on disk before it reports back. Minutes, not the
 * day-granular window, because the question is what is running.
 */
const running: Query = {
  name: "running",
  summary: "sessions and subagents active in the last few minutes, and what each is doing",
  usage: "dim q running [minutes]",
  spansHistory: true,
  run: (db, ctx) => {
    const { arg } = ctx;
    const minutes = arg && /^\d+$/.test(arg) ? Number(arg) : 30;
    const columns = ["id", "kind", "project", "last_seen", "doing"];
    const records = table(
      db,
      `SELECT substr(s.id, 1, 8) AS id,
              CASE WHEN s.parent_id IS NULL THEN s.tool
                   ELSE 'sub:' || coalesce(s.agent_type, '?') END AS kind,
              replace(coalesce(s.project, ''), ? || '/', '') AS project,
              substr(s.last_seen_at, 12, 5) AS last_seen,
              coalesce(
                (SELECT replace(substr(m.text, 1, 140), char(10), ' ') FROM message m
                 WHERE m.session_id = s.id AND m.text IS NOT NULL
                   AND m.is_skill_body = 0 AND m.is_meta = 0
                 ORDER BY m.ts DESC LIMIT 1),
                (SELECT t.tool_name || ' ' || coalesce(t.file_path, '') FROM tool_call t
                 WHERE t.session_id = s.id ORDER BY t.ts_call DESC LIMIT 1),
                '(nothing recorded)') AS doing
       FROM session s
       -- Timestamps are stored ISO with a T; datetime() renders a space, which
       -- sorts below it and would put every row inside the window.
       WHERE s.last_seen_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
       ORDER BY s.last_seen_at DESC LIMIT 40`,
      [homeOf(ctx), `-${minutes} minutes`],
    );
    const synced = scalar(db, "SELECT count(*) AS n FROM source_file");
    return {
      denominator: `sessions active in the last ${minutes} minutes, of ${synced} source files read`,
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? `nothing active in the last ${minutes} minutes — run \`dim sync\` first, since only bytes already read are here`
          : "A subagent's rows are its own transcript, not its report to the parent. This is as fresh as the " +
            "last `dim sync`: nothing here watches a file.",
    };
  },
};

/**
 * The repo's own verdict on work a session did. Every other number here is
 * process — what was said, loaded, called, stopped — and process cannot say
 * whether the code was right. A later `fix:` commit touching a file an agent
 * edited is somebody having to come back to it, which is an outcome and is
 * written down whether or not anyone noticed at the time.
 */
/**
 * Goal 3, read out of the same join as `fixes` and in the other direction: files
 * an agent wrote, that shipped, and that no later fix commit returned to. It
 * starts from what an agent edited rather than from every committed file, so a
 * generated changelog with a thousand commits cannot outrank written code.
 * A nomination, never a verdict — the label has to come from a reader.
 */
const exemplars: Query = {
  name: "exemplars",
  summary: "code an agent wrote that shipped and no fix came back to — candidates, not verdicts",
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
       WHERE r.path IS NULL AND e.edits >= 3
       ORDER BY e.edits DESC, days_since DESC
       LIMIT 25`,
      [...w.params, homeOf(ctx)],
    );
    return {
      denominator:
        `${scalar(db, "SELECT count(*) AS n FROM repo_commit")} commits read from the repos on disk ` +
        `(${windowLine(ctx)}); a file needs three agent edits and one commit to appear, and the top 25 are shown`,
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? "no agent-edited file in this window has shipped"
          : "A nomination, never a verdict: nobody coming back to a file is not evidence it is right, only that it was " +
            "not revisited. A fix committed without the conventional prefix is invisible here, a file is matched by path " +
            "so repos sharing a name collide, and a file still being worked on today will read as untested rather than sound.",
    };
  },
};

const fixes: Query = {
  name: "fixes",
  summary: "files an agent edited that a later fix commit had to come back to, by skill",
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
       GROUP BY skill HAVING files >= 20
       ORDER BY fixed_pct DESC`,
      w.params,
    );
    const commits = scalar(db, "SELECT count(*) AS n FROM repo_commit");
    const fixCommits = scalar(db, "SELECT count(*) AS n FROM repo_commit WHERE kind = 'fix'");
    return {
      denominator:
        `${fixCommits} fix commits of ${commits} read from the repos on disk (${windowLine(ctx)}); ` +
        "rows shown only where a skill touched at least 20 files",
      columns,
      rows: toRows(records, columns),
      note:
        commits === 0
          ? "no commits read: the working directories in this corpus are gone or were never repos. `dim sync`."
          : records.length === 0
            ? "no skill touched enough files in this window to report a rate"
            : "A `fix:` commit naming a file is the repo's verdict that the file needed changing, not " +
              "proof the agent caused it — a fix may land on code it never wrote, and work nobody came " +
              "back to may still be wrong. `mean_days` covers only the files that were fixed. Matching is by conventional-commit type, so a fix committed without the " +
              "prefix is invisible here.",
    };
  },
};

const STOPWORDS = new Set(
  "the a an and or but if then this that these those is are was were be been it its to of in on for with as at by from you i we they he she do does did not no so up out".split(
    " ",
  ),
);

/**
 * Anything longer is a document, not a sentence: a pasted handoff, a log, a spec.
 * Without this the count is dominated by templates the owner pasted rather than
 * wrote — the handoff format alone appears in 207 sessions.
 */
const SAID_MAX_CHARS = 400;

/** Boilerplate the tool writes into a user turn, which is not something anyone said. */
const BOILERPLATE = /\[request interrupted|tool use was rejected|the user (wants|doesn)/i;

function phrases(text: string, size: number): string[] {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i += 1) {
    const slice = words.slice(i, i + size);
    // A phrase that is only filler recurs everywhere and means nothing.
    if (slice.every((w) => STOPWORDS.has(w))) continue;
    out.push(slice.join(" "));
  }
  return out;
}

/**
 * What the owner says over and over. A rule stated three times in three sessions
 * is a rule that belongs in the guidance every session loads, not a fact to be
 * retrieved later — which is the whole difference between a memory that fires
 * and one that sits there. Counting, not judging: nothing here is a model call.
 */
const repeats: Query = {
  name: "repeats",
  summary: "phrases you have used in several sessions when stopping or correcting the agent",
  usage: "dim q repeats [words-per-phrase]",
  run: (db, ctx) => {
    const size = ctx.arg && /^\d+$/.test(ctx.arg) ? Number(ctx.arg) : 4;
    const w = window("m.ts", ctx);
    const rows = table(
      db,
      `SELECT m.id, m.session_id, coalesce(m.user_feedback, m.text, '') AS said
       FROM message m
       WHERE m.role = 'user'
         AND (m.denial_kind IS NOT NULL OR m.interrupted_message_id IS NOT NULL
              OR m.user_feedback IS NOT NULL OR m.prompt_source IN ('typed','queued'))
         AND m.text IS NOT NULL AND m.text_chars <= ${SAID_MAX_CHARS}${w.sql}`,
      w.params,
    ) as { id: string; session_id: string; said: string }[];

    const seen = new Map<string, { sessions: Set<string>; uses: number }>();
    for (const row of rows) {
      if (!row.said || BOILERPLATE.test(row.said)) continue;
      for (const phrase of new Set(phrases(row.said, size))) {
        const hit = seen.get(phrase) ?? { sessions: new Set<string>(), uses: 0 };
        hit.sessions.add(row.session_id);
        hit.uses += 1;
        seen.set(phrase, hit);
      }
    }

    // Sliding an n-gram window over one sentence yields several phrases that are
    // mostly the same words, and they would otherwise fill the list three deep
    // with one habit. The strongest wins and its near-duplicates drop.
    const kept: { phrase: string; words: Set<string>; sessions: number; uses: number }[] = [];
    for (const [phrase, v] of [...seen.entries()]
      .filter(([, x]) => x.sessions.size >= 3)
      .sort((a, b) => b[1].sessions.size - a[1].sessions.size || b[1].uses - a[1].uses)) {
      const words = new Set(phrase.split(" "));
      const overlaps = kept.some((k) => {
        let shared = 0;
        for (const word of words) if (k.words.has(word)) shared += 1;
        return shared >= Math.max(2, words.size - 1);
      });
      if (!overlaps) kept.push({ phrase, words, sessions: v.sessions.size, uses: v.uses });
      if (kept.length >= 30) break;
    }

    const columns = ["phrase", "sessions", "uses"];
    const records = kept.map(({ phrase, sessions, uses }) => ({ phrase, sessions, uses }));

    return {
      denominator: `${rows.length} prompts you typed or used to stop the agent (${windowLine(ctx)}); phrases of ${size} words seen in 3+ sessions`,
      columns,
      rows: toRows(records, columns),
      note:
        records.length === 0
          ? "nothing recurs across three sessions in this window; try fewer words per phrase or a wider window"
          : "A phrase is a place to look, not a rule. What recurs may be a habit of speech rather than an " +
            "instruction — read the sessions before promoting one into guidance every session will load.",
    };
  },
};

/**
 * One call for a scheduled reader, so the measure step of the loop is a job
 * rather than a sitting. It reports over whatever window it is given and names
 * it: `--since 7d` for a weekly cadence. Every figure here is also reachable on
 * its own, and this adds no measurement of its own — a digest that computed
 * something no other query could would be a number with nowhere to check it.
 */
const digest: Query = {
  name: "digest",
  summary: "the whole week in one call: friction, where work happened, what you repeated",
  run: (db, ctx) => {
    const w = (col: string) => window(col, ctx);
    const rows: (string | number | null)[][] = [];
    const add = (measure: string, value: string | number | null) => rows.push([measure, value]);

    const sessions = scalar(
      db,
      `SELECT count(*) AS n FROM session WHERE parent_id IS NULL${window("last_seen_at", ctx).sql}`,
      ...w("last_seen_at").params,
    );
    add("sessions", sessions);

    const edited = scalar(
      db,
      `SELECT count(*) AS n FROM (SELECT DISTINCT session_id, file_path FROM tool_call
        WHERE tool_name IN ('Edit','Write') AND file_path IS NOT NULL${w("ts_call").sql})`,
      ...w("ts_call").params,
    );
    const unskilled = scalar(
      db,
      `SELECT count(*) AS n FROM (SELECT DISTINCT session_id, file_path FROM tool_call
        WHERE tool_name IN ('Edit','Write') AND file_path IS NOT NULL
          AND attribution_skill IS NULL${w("ts_call").sql})`,
      ...w("ts_call").params,
    );
    add("files edited", edited);
    add(
      "edited under no skill",
      edited === 0 ? "—" : `${unskilled} (${Math.round((100 * unskilled) / edited)}%)`,
    );

    const stops = scalar(
      db,
      `SELECT count(*) AS n FROM message m
       WHERE m.role = 'user'
         AND (m.denial_kind IS NOT NULL OR m.interrupted_message_id IS NOT NULL
              OR m.user_feedback IS NOT NULL)${w("m.ts").sql}`,
      ...w("m.ts").params,
    );
    add("times you stopped the agent", stops);
    add("stops per file edited", edited === 0 ? "—" : (stops / edited).toFixed(2));

    const handoffs = scalar(
      db,
      `SELECT count(*) AS n FROM tool_call
       WHERE tool_name IN ('Agent','SendMessage')${w("ts_call").sql}`,
      ...w("ts_call").params,
    );
    add("work handed to a subagent or peer", handoffs);

    // Guidance that changed inside the window is the other half of any change in
    // the numbers above, and reading them apart invites crediting the wrong one.
    const skillVersions = scalar(
      db,
      `SELECT count(DISTINCT body_sha256) AS n FROM skill_load
       WHERE body_sha256 IS NOT NULL${w("ts").sql}`,
      ...w("ts").params,
    );
    const ruleVersions = scalar(
      db,
      `SELECT count(*) AS n FROM guidance_version${window("first_seen", ctx, "WHERE").sql}`,
      ...w("first_seen").params,
    );
    add("skill versions loaded", skillVersions);
    add("rules file versions written", ruleVersions);

    for (const r of repeats.run(db, ctx).rows.slice(0, 5)) {
      add("repeated", `"${r[0]}" — ${r[1]} sessions`);
    }

    return {
      denominator: `${windowLine(ctx)}`,
      columns: ["measure", "value"],
      rows,
      note:
        sessions === 0
          ? "no session in this window"
          : "A repeated phrase is a candidate rule or a rule that is not reaching the tool that needs it. " +
            "Nothing here is an effect of anything else here: read a change as where to look.",
    };
  },
};

/**
 * How far the code a session touched has moved since it ran. This is the gate
 * `acolyte import` settled on, measured per file rather than per repo: a session
 * whose files have been rewritten describes code that no longer exists, so its
 * conclusions are worth less than their confidence suggests.
 *
 * It scores the area, not the work. A file everyone edits moves whatever was
 * done to it, and a file nobody touches sits still even if it is wrong.
 */
const stale: Query = {
  name: "stale",
  summary: "how much the code a session touched has changed since it ran",
  usage: "dim q stale [id-prefix]",
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
      // The filter and window sit in the CTE, which precedes the SELECT this
      // binds in, and SQLite binds by position in the text.
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
        commits === 0
          ? "`dim sync` from a machine holding the repos; without commits there is no measure of movement"
          : "`moved_pct` is the share of the files that have been committed to since, and `commits_since` how " +
            "often in total. Both are shown because neither is the score: the share says whether the session's " +
            "ground moved, the count how far. The per-repo gate `acolyte import` settled on is the count. " +
            "It measures the area, not the work: a file under constant edit moves whatever was done to it. " +
            "Read a high score as evidence that what this session concluded is about code that has changed, " +
            "never as evidence the session was wrong.",
    };
  },
};

/**
 * How the same problem was solved in the repos already on disk. It reads
 * `repo_file`, so every path it prints opens, and dates each one from the
 * commits that touched it, so a settled file can be told from an abandoned one.
 * The alternative is a survey of every checkout, which is what this replaces.
 */
/** A repo with fifty workflow files would otherwise be the whole answer, and one example from it is enough. */
const PER_REPO = 3;

const priorArt: Query = {
  name: "prior-art",
  summary: "where a path like this one already exists across the repos on disk, newest first",
  usage: 'dim q prior-art "<path fragment>"',
  spansHistory: true,
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

/**
 * The work a task spans, rather than the session it happened to be in. Every
 * other per-session measure here counts a link as a whole piece of work; this
 * is the column that says how many links were behind it.
 */
const chain: Query = {
  name: "chain",
  summary: "sessions that continued one another through a handoff, longest chain first",
  usage: "dim q chain [id-prefix]",
  spansHistory: true,
  run: (db, ctx) => {
    const { arg } = ctx;
    if (arg) {
      const columns = ["step", "session", "ran", "gap_min", "title"];
      // Both directions from the named session, following the edge each way.
      const records = table(
        db,
        `WITH RECURSIVE back(from_session, to_session, to_ts, from_ts, title) AS (
           SELECT from_session, to_session, to_ts, from_ts, title FROM handoff_link
           WHERE to_session LIKE ? || '%'
           UNION
           SELECT l.from_session, l.to_session, l.to_ts, l.from_ts, l.title
           FROM handoff_link l JOIN back b ON l.to_session = b.from_session
         ),
         forward(from_session, to_session, to_ts, from_ts, title) AS (
           SELECT from_session, to_session, to_ts, from_ts, title FROM handoff_link
           WHERE from_session LIKE ? || '%'
           UNION
           SELECT l.from_session, l.to_session, l.to_ts, l.from_ts, l.title
           FROM handoff_link l JOIN forward f ON l.from_session = f.to_session
         ),
         edge AS (SELECT * FROM back UNION SELECT * FROM forward)
         SELECT row_number() OVER (ORDER BY to_ts) AS step,
                substr(from_session, 1, 8) || ' → ' || substr(to_session, 1, 8) AS session,
                substr(to_ts, 1, 16) AS ran,
                cast((julianday(to_ts) - julianday(from_ts)) * 1440 AS INTEGER) AS gap_min,
                ltrim(replace(title, '# Handoff', ''), ' —') AS title
         FROM edge ORDER BY to_ts`,
        [arg, arg],
      );
      return {
        denominator: `the chain ${arg} sits in: ${records.length} links`,
        columns,
        rows: toRows(records, columns),
        note:
          records.length === 0
            ? `no handoff joins ${arg} to another session; \`dim q resume ${arg}\` has what it left`
            : "`gap_min` is the wait between a handoff being printed and pasted, not work. The walk " +
              "follows the edge, not the title, so it crosses a task that was renamed midway, and it " +
              "branches where one handoff was pasted into two sessions. A chain breaks where the " +
              "writing session's transcript was pruned before it was read.",
      };
    }

    const columns = ["links", "first", "last", "title"];
    const w = window("to_ts", ctx, "WHERE");
    const records = table(
      db,
      `SELECT count(*) AS links,
              substr(min(from_ts), 1, 10) AS first,
              substr(max(to_ts), 1, 10) AS last,
              ltrim(replace(title, '# Handoff', ''), ' —') AS title
       FROM handoff_link${w.sql}
       GROUP BY title ORDER BY links DESC, last DESC LIMIT 30`,
      w.params,
    );
    const links = scalar(db, "SELECT count(*) AS n FROM handoff_link");
    const pasted = scalar(
      db,
      `SELECT count(*) AS n FROM message WHERE role = 'user' AND text LIKE '%# Handoff%' AND text LIKE '%## Next%'`,
    );
    return {
      denominator: `${links} links joined, of ${pasted} handoffs pasted into a session (${windowLine(ctx)})`,
      columns,
      rows: toRows(records, columns),
      note:
        links === 0
          ? "nothing is joined; `dim sync` builds this table from the transcripts it has read"
          : "Grouped by the handoff title, which is what the two sides share, so a task renamed midway " +
            "reads as two chains. A paste with no link means the session that printed it was pruned " +
            "before its transcript was read.",
    };
  },
};

export const QUERIES: Query[] = [
  priorArt,
  chain,
  digest,
  stale,
  search,
  thread,
  skill,
  resume,
  delegation,
  running,
  fixes,
  exemplars,
  repeats,
  burn,
  tokens,
  models,
  cost,
  turns,
  tools,
  skills,
  corrections,
  candidates,
  rework,
  sessions,
  session,
];

export function findQuery(name: string): Query | undefined {
  return QUERIES.find((q) => q.name === name);
}
