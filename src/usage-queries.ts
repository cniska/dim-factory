import { type Query, scalar, table, toRows, window, windowLine } from "./query";
import { corpusLine } from "./session-queries";

export const tokens: Query = {
  name: "tokens",
  summary: "input, cache and output tokens per tool and model",
  window: ["u.ts", "last_seen_at", "ts"],
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
      note:
        records.length === 0
          ? "no usage rows"
          : "Claude excludes cached reads from input; Codex includes them. Not summed across tools.",
    };
  },
};

export const burn: Query = {
  name: "burn",
  summary: "spend against edits per rolling five-hour block — how much a block turned into changes",
  window: ["u.ts", "last_seen_at", "ts"],
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

export const models: Query = {
  name: "models",
  summary: "sessions, responses and tokens per model per month — descriptive only",
  spansHistory: true,
  window: ["u.ts", "last_seen_at", "ts"],
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
      note: "Descriptive. Nothing here compares models; the corpus has no arm held fixed.",
    };
  },
};

export const cost: Query = {
  name: "cost",
  summary: "cost as each tool reported it, never derived here",
  spansHistory: true,
  window: "coalesce(c.ts, s.started_at)",
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

export const turns: Query = {
  name: "turns",
  summary: "turn duration and how turns ended, per tool",
  window: "t.ts_end",
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
