import {
  CLAUDE_STOPS,
  claudeOnly,
  type Query,
  scalar,
  stoppedByOwner,
  table,
  toRows,
  window,
  windowLine,
} from "./query";

export const tools: Query = {
  name: "tools",
  summary: "tool call counts, failures and the read-to-edit ratio per tool",
  window: "t.ts_call",
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
      note: "Claude records no exit code; its failure count is what the transcript marked, not every non-zero exit.",
    };
  },
};

export const skills: Query = {
  name: "skills",
  summary: "how often each skill loaded, by which path, and what its body cost",
  window: "l.ts",
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

export const skill: Query = {
  name: "skill",
  summary: "one skill, version by version: loads, size, and what got stopped under each",
  usage: "dim q skill <name>",
  spansHistory: true,
  window: "l.ts",
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
           AND ${stoppedByOwner()}
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
        (records.length === 0
          ? `no load of ${arg} recorded; \`dim q skills\` names the skills that have loaded. `
          : "`stopped` counts acts the tool recorded — a rejection, an interruption, written feedback — " +
            "under the version loaded at the time, never a judgement that the skill was wrong. Versions " +
            "differ in the tasks they met as well as in their text, so read a change as where to look." +
            (unmeasured
              ? " `(unmeasured)` is every load that reported no body: Codex reads the file itself, so its " +
                "loads carry no hash and fall together in one row rather than splitting by version. "
              : " ")) + claudeOnly(CLAUDE_STOPS),
    };
  },
};
