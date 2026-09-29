import { type Query, table, toRows, window } from "./query";
import { corpusLine } from "./query-session";

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
