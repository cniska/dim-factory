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
import { EMBED_MODEL, fromBlob, similarity } from "./search-embed";

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

const SAID = "(m.is_meta = 0 OR m.origin_kind IN ('coordinator', 'peer'))";

function keywordSearch(db: Database, ctx: QueryContext, terms: string): QueryResult {
  const columns = ["session", "when", "role", "project", "terms", "text"];
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
          `SELECT count(*) AS n FROM message_fts JOIN message m ON m.rowid = message_fts.rowid
           WHERE message_fts MATCH ? AND ${SAID}${w.sql}`,
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
     SELECT substr(m.session_id, 1, 8) AS session, substr(m.ts, 1, 16) AS "when", m.role,
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
        : ""),
    columns,
    rows: toRows(records, columns),
    note:
      records.length === 0
        ? `nothing matches ${terms}; a message with no text is a tool call or its result, and a reminder ` +
          `the harness injected is nothing anyone said, so neither is searched`
        : undefined,
  };
}

const degradedToKeywords = (db: Database, ctx: QueryContext, terms: string, why: string): QueryResult => {
  const result = keywordSearch(db, ctx, terms);
  return { ...result, path: "keyword", denominator: `${result.denominator} Meaning was not ranked: ${why}` };
};

const SEMANTIC_HITS = 20;

const SNIPPET_CHARS = 96;

const PLACE_CHARS = 30;

const snippet = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SNIPPET_CHARS ? `${line.slice(0, SNIPPET_CHARS - 1)}…` : line;
};

const place = (value: string | null): string | null => {
  if (value === null || value.length <= PLACE_CHARS) return value;
  return `…${value.slice(value.length - (PLACE_CHARS - 1))}`;
};

const hasEmbeddings = (db: Database): boolean =>
  scalar(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'embedding'") > 0;

export const search: Query = {
  name: "search",
  summary: "find a distilled passage by meaning, falling back to keywords",
  usage: 'dim q search "<question>"',
  spansHistory: true,
  window: "coalesce(m.ts, c.ts)",
  embedsArg: true,
  run: (db, ctx) => {
    const { arg, question } = ctx;
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [['usage: dim q search "<question>"']] };
    }
    if (!question) throw new Error("search ranks by meaning, so the caller must resolve ctx.question");
    if (!hasEmbeddings(db)) {
      return degradedToKeywords(db, ctx, arg, "this database predates the embedding index; run `dim embed`");
    }
    if ("unavailable" in question) return degradedToKeywords(db, ctx, arg, question.unavailable);

    const w = window("coalesce(m.ts, c.ts)", ctx, "WHERE");
    const inWindow = db
      .prepare<{ kind: string; ref: string; vector: Uint8Array; model: string }, string[]>(
        `SELECT e.kind, e.ref, e.vector, e.model
         FROM embedding e
         LEFT JOIN message m ON e.kind <> 'subject' AND m.id = e.ref
         LEFT JOIN repo_commit c ON e.kind = 'subject' AND c.sha = e.ref${w.sql}`,
      )
      .all(...w.params);
    const rows = inWindow.filter((row) => row.model === EMBED_MODEL);
    const otherScale = inWindow.length - rows.length;
    if (rows.length === 0) {
      return degradedToKeywords(
        db,
        ctx,
        arg,
        otherScale > 0
          ? "every vector in this window was built by another model; run `dim embed`"
          : "nothing is embedded in this window; run `dim embed`",
      );
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
              CASE WHEN e.kind = 'subject' THEN substr(e.ref, 1, 8)
                   ELSE substr(m.session_id, 1, 8) || '@' || m.ts END AS ref,
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

    const byKind = table(
      db,
      "SELECT kind, count(*) AS n FROM embedding WHERE model = ? GROUP BY kind ORDER BY kind",
      [EMBED_MODEL],
    )
      .map((r) => `${r.n} ${r.kind}`)
      .join(", ");
    return {
      path: "cosine",
      denominator:
        `cosine over ${rows.length} distilled passages in this window, of ${byKind} embedded ` +
        `by ${EMBED_MODEL}` +
        (otherScale > 0 ? `, ${otherScale} in this window built by another model and not ranked` : "") +
        ` (${windowLine(ctx)}); the ${records.length} closest shown`,
      columns,
      rows: toRows(records as unknown as Record<string, unknown>[], columns),
      note:
        "Meaning, not words: a hit need share no term with the question, and a low score is still the " +
        "closest thing indexed rather than an answer. This index holds text a person distilled — a " +
        "handoff's Next, a subject they authored, a prompt they labeled a correction — and no raw " +
        "conversation turn, so a sentence said in passing is not in it. `dim q thread <ref>` reads the " +
        "exchange a next or a correction came from, centered on the passage the ref names.",
    };
  },
};

export const keywords: Query = {
  name: "keywords",
  summary: "find a message by the words in it, across every session",
  usage: 'dim q keywords "<words>"',
  spansHistory: true,
  window: "m.ts",
  run: (db, ctx) => {
    const { arg } = ctx;
    if (!arg) {
      return { denominator: "", columns: ["error"], rows: [['usage: dim q keywords "<words>"']] };
    }
    const result = keywordSearch(db, ctx, arg);
    return {
      ...result,
      denominator:
        `${result.denominator} Words, not meaning: \`dim q search\` ranks distilled text, and ` +
        "`dim q thread <session>@<when>` reads the exchange a hit sits in.",
    };
  },
};
