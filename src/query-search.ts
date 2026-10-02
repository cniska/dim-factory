import { type Query, requiredArg, SAID, scalar, select } from "./query";

const MAX_TERMS = 16;

type Term = { readonly word: string; readonly quoted: string };

function termsOf(words: string): { readonly terms: readonly Term[]; readonly dropped: number } {
  const all = words.split(/\s+/).filter(Boolean);
  return {
    terms: all.slice(0, MAX_TERMS).map((word) => ({ word, quoted: `"${word.replaceAll('"', '""')}"` })),
    dropped: Math.max(0, all.length - MAX_TERMS),
  };
}

export const search: Query = {
  name: "search",
  summary: "find a message by the words in it, across every session",
  usage: 'dim query search "<words>"',
  run: (db, ctx) => {
    const words = requiredArg(ctx, search.usage);
    const { terms, dropped } = termsOf(words);
    const quoted = terms.map((term) => term.quoted);
    const saidNothing = (term: Term) =>
      scalar(
        db,
        `SELECT EXISTS (SELECT 1 FROM message_fts JOIN message m ON m.rowid = message_fts.rowid
         WHERE message_fts MATCH ? AND ${SAID}) AS n`,
        [term.quoted],
      ) === 0;
    const missing = [...new Set(terms.filter(saidNothing).map((term) => term.word))];
    const perTerm = quoted
      .map(() => "SELECT rowid FROM message_fts WHERE message_fts MATCH ?")
      .join(" UNION ALL ");
    const result = select(
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
       ORDER BY c.matched DESC, bm25(message_fts) ASC, m.ts DESC LIMIT ?`,
      [...quoted, ctx.home, quoted.length, quoted.join(" OR "), ctx.maxRows + 1],
    );
    const said = scalar(db, `SELECT count(*) AS n FROM message m WHERE m.text IS NOT NULL AND ${SAID}`);
    const all = scalar(db, "SELECT count(*) AS n FROM message");
    return {
      denominator:
        `keywords over ${said} of ${all} messages that carry text anyone said; ` +
        `ranked by how many of the ${quoted.length} terms matched, ties broken by relevance then recency.` +
        `${dropped > 0 ? ` Only the first ${MAX_TERMS} words were searched; ${dropped} more were dropped.` : ""}` +
        (missing.length > 0
          ? ` ${missing.length === 1 ? "This term matched" : "These terms matched"} nothing anyone said: ${missing.join(", ")}.`
          : "") +
        " `dim query thread <session>@<when>` reads the exchange a hit sits in.",
      ...result,
      note:
        result.rows.length === 0
          ? `nothing matches ${words}; a message with no text is a tool call or its result, and a reminder ` +
            `the harness injected is nothing anyone said, so neither is searched`
          : null,
    };
  },
};
