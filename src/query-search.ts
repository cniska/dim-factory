import type { Database } from "bun:sqlite";
import { type Query, type QueryContext, type QueryResult, requiredArg, scalar, table, toRows } from "./query";

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
  const matchAny = quoted.join(" OR ");
  const byWord = new Map(raw.map((word, i) => [word, quoted[i] as string]));
  const missing = [...byWord]
    .filter(
      ([, quote]) =>
        scalar(
          db,
          `SELECT EXISTS (SELECT 1 FROM message_fts JOIN message m ON m.rowid = message_fts.rowid
           WHERE message_fts MATCH ? AND ${SAID}) AS n`,
          quote,
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
     WHERE message_fts MATCH ? AND ${SAID}
     ORDER BY c.matched DESC, bm25(message_fts) ASC, m.ts DESC LIMIT 40`,
    [...quoted, ctx.home, String(quoted.length), matchAny],
  );
  const said = scalar(db, `SELECT count(*) AS n FROM message m WHERE m.text IS NOT NULL AND ${SAID}`);
  const all = scalar(db, "SELECT count(*) AS n FROM message");
  return {
    denominator:
      `keywords over ${said} of ${all} messages that carry text anyone said; ` +
      `ranked by how many of the ${quoted.length} terms matched, ties broken by relevance then recency; ` +
      `top 40 shown.${dropped > 0 ? ` Only the first ${MAX_TERMS} words were searched; ${dropped} more were dropped.` : ""}` +
      (missing.length > 0
        ? ` ${missing.length === 1 ? "This term matched" : "These terms matched"} nothing anyone said: ${missing.join(", ")}.`
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
  run: (db, ctx) => keywordSearch(db, ctx, requiredArg(ctx, search.usage)),
};
