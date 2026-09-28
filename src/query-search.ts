import type { Database } from "bun:sqlite";
import {
  homeOf,
  type Query,
  type QueryContext,
  type QueryResult,
  scalar,
  table,
  toRows,
  window,
  windowLine,
} from "./query";

const MAX_TERMS = 16;

const quotedTerms = (terms: string): { raw: string[]; quoted: string[]; dropped: number } => {
  const words = terms.split(/\s+/).filter(Boolean);
  const kept = words.slice(0, MAX_TERMS);
  return {
    raw: kept,
    quoted: kept.map((t) => `"${t.replaceAll('"', '""')}"`),
    dropped: Math.max(0, words.length - MAX_TERMS),
  };
};

export const SAID = "m.is_skill_body = 0 AND (m.is_meta = 0 OR m.origin_kind IN ('coordinator', 'peer'))";

function keywordSearch(db: Database, ctx: QueryContext, terms: string): QueryResult {
  const columns = ["session", "when", "ref", "role", "project", "terms", "text"];
  const { raw, quoted, dropped } = quotedTerms(terms);
  if (quoted.length === 0) {
    return { denominator: "", columns: ["error"], rows: [["nothing to search for but whitespace"]] };
  }
  const matchAny = quoted.join(" OR ");
  const w = window("m.ts", ctx);
  const byWord = new Map(raw.map((word, i) => [word, quoted[i] as string]));
  const missing = [...byWord]
    .filter(
      ([, quote]) =>
        scalar(
          db,
          `SELECT EXISTS (SELECT 1 FROM message_fts JOIN message m ON m.rowid = message_fts.rowid
           WHERE message_fts MATCH ? AND ${SAID}${w.sql}) AS n`,
          quote,
          ...w.params,
        ) === 0,
    )
    .map(([word]) => word);
  const perTerm = quoted
    .map(() => "SELECT rowid FROM message_fts WHERE message_fts MATCH ?")
    .join(" UNION ALL ");
  const records = table(
    db,
    `WITH per_term AS (${perTerm}),
          counted AS (SELECT rowid, count(*) AS matched FROM per_term GROUP BY rowid)
     SELECT substr(m.session_id, 1, 8) AS session, substr(m.ts, 1, 16) AS "when",
            m.session_id || '@' || m.ts AS ref, m.role,
            replace(coalesce(s.project, ''), ? || '/', '') AS project,
            c.matched || '/' || ? AS terms,
            replace(snippet(message_fts, 0, '[', ']', '…', 12), char(10), ' ') AS text
     FROM counted c
     JOIN message_fts ON message_fts.rowid = c.rowid
     JOIN message m ON m.rowid = c.rowid
     JOIN session s ON s.id = m.session_id
     WHERE message_fts MATCH ? AND ${SAID}${w.sql}
     ORDER BY c.matched DESC, bm25(message_fts) ASC, m.ts DESC LIMIT 40`,
    [...quoted, homeOf(ctx), String(quoted.length), matchAny, ...w.params],
  );
  const searchable = window("m.ts", ctx);
  const every = window("ts", ctx, "WHERE");
  const said = scalar(
    db,
    `SELECT count(*) AS n FROM message m WHERE m.text IS NOT NULL AND ${SAID}${searchable.sql}`,
    ...searchable.params,
  );
  const all = scalar(db, `SELECT count(*) AS n FROM message${every.sql}`, ...every.params);
  return {
    denominator:
      `keywords over ${said} of ${all} messages that carry text anyone said (${windowLine(ctx)}); ` +
      `ranked by how many of the ${quoted.length} terms matched, ties broken by relevance then recency; ` +
      `top 40 shown.${dropped > 0 ? ` Only the first ${MAX_TERMS} words were searched; ${dropped} more were dropped.` : ""}` +
      (missing.length > 0
        ? ` ${missing.length === 1 ? "This term matched" : "These terms matched"} nothing anyone said in this window: ${missing.join(", ")}.`
        : "") +
      " `dim q thread <session>@<when>` reads the exchange a hit sits in.",
    columns,
    rows: toRows(records, columns),
    note:
      records.length === 0
        ? `nothing matches ${terms}; a message with no text is a tool call or its result, and a reminder ` +
          `the harness injected is nothing anyone said, so neither is searched`
        : undefined,
  };
}

export const search: Query = {
  name: "search",
  summary: "find a message by the words in it, across every session",
  usage: 'dim q search "<words>"',
  spansHistory: true,
  window: "m.ts",
  run: (db, ctx) => {
    const { arg } = ctx;
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [['usage: dim q search "<words>"']] };
    }
    return keywordSearch(db, ctx, arg);
  },
};
