import {
  CLAUDE_EDITS,
  CLAUDE_STOPS,
  claudeOnly,
  type Query,
  type QueryContext,
  scalar,
  stoppedByOwner,
  table,
  toRows,
  window,
  windowLine,
} from "./query";

const attributed = (ctx: QueryContext): string => `
  SELECT m.id, m.session_id, m.ts, m.model, m.text, m.denial_kind, m.user_feedback,
         m.interrupted_message_id,
         (SELECT p.attribution_skill FROM message p
          WHERE p.session_id = m.session_id AND p.role = 'assistant' AND p.ts <= m.ts
          ORDER BY p.ts DESC, p.src_line DESC LIMIT 1) AS skill
  FROM message m
  WHERE m.role = 'user'
    AND ${stoppedByOwner()}${window("m.ts", ctx).sql}`;

export const corrections: Query = {
  name: "corrections",
  summary: "the mechanical signals that the user stopped the agent, by skill",
  window: "m.ts",
  run: (db, ctx) => {
    const { arg } = ctx;
    const columns = ["skill", "rejected", "interrupted", "with_feedback", "labeled", "sessions"];
    const w = window("m.ts", ctx);
    const records = table(
      db,
      `WITH c AS (${attributed(ctx)})
       SELECT coalesce(c.skill, '(unattributed)') AS skill,
              sum(coalesce(c.denial_kind, '') = 'user-rejected') AS rejected,
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
        (candidates === 0
          ? "no rejection, interruption or written feedback in the corpus. "
          : "These are acts the tool recorded, not judgements. Whether a prompt told the agent it was " +
            "wrong is semantic and nothing here decides it; `dim label` records the owner's call. " +
            "An unlabeled candidate is never counted as a correction. ") + claudeOnly(CLAUDE_STOPS),
    };
  },
};

export const candidates: Query = {
  name: "candidates",
  summary: "unlabeled turns the user stopped, with enough text to judge them",
  window: "m.ts",
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
              CASE WHEN c.denial_kind = 'user-rejected' THEN 'rejected'
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
        (records.length === 0
          ? total === 0
            ? "no rejection, interruption or written feedback in this window. "
            : "every candidate in this window has been labeled. "
          : "A stop is an act, not a verdict: an interruption can be a correction, a change of mind, or " +
            "a faster idea. Read the text, then `dim label <message_id> <correction|clarification|not_correction>`. " +
            "Nothing here labels itself. ") + claudeOnly(CLAUDE_STOPS),
    };
  },
};

export const rework: Query = {
  name: "rework",
  summary: "files the agent had to revisit after you pushed back, by skill",
  window: "t.ts_call",
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
                   AND ${stoppedByOwner()}) AS stops
         FROM spans s
       )
       SELECT skill,
              count(*) AS files_touched,
              sum(edits > 1) AS revisited,
              sum(edits > 1 AND stops > 0) AS after_pushback,
              round(100.0 * sum(edits > 1 AND stops > 0) / count(*), 1) AS pushback_rate
       FROM marked
       ${arg ? "WHERE skill = ?" : ""}
       GROUP BY skill
       ORDER BY pushback_rate DESC, files_touched DESC, skill`,
      [...window("t.ts_call", ctx).params, ...(arg ? [arg] : [])],
    );
    const w = window("ts_call", ctx);
    const total = scalar(
      db,
      `SELECT count(*) AS n FROM tool_call
       WHERE tool_name IN ('Edit','Write') AND file_path IS NOT NULL AND ts_call IS NOT NULL${w.sql}
       ${arg ? "AND coalesce(attribution_skill, '(no skill)') = ?" : ""}`,
      ...w.params,
      ...(arg ? [arg] : []),
    );
    return {
      denominator:
        `${total} file edits${arg ? ` under ${arg}` : ""}; ` +
        `${arg ? "rows cover it alone, and" : "every skill that edited a file is a row, and"}` +
        ` \`files_touched\` is the base each rate stands on (${windowLine(ctx)})`,
      columns,
      rows: toRows(records, columns),
      note:
        (records.length === 0
          ? arg
            ? `no file edit in this window is attributed to ${arg}. `
            : "no agent edit in this window has the file path and timestamp a row needs. "
          : "`after_pushback` counts a file revisited while the user was stopping the agent. It is a " +
            "co-occurrence, not a cause: a skill loads because the task is a certain kind. Read it as " +
            "where to look, never as which skill is worse. ") + claudeOnly(CLAUDE_EDITS, CLAUDE_STOPS),
    };
  },
};

const STOPWORDS = new Set(
  "the a an and or but if then this that these those is are was were be been it its to of in on for with as at by from you i we they he she do does did not no so up out".split(
    " ",
  ),
);

const SAID_MAX_CHARS = 400;

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
    if (slice.every((w) => STOPWORDS.has(w))) continue;
    out.push(slice.join(" "));
  }
  return out;
}

export const repeats: Query = {
  name: "repeats",
  summary: "phrases you have used in several sessions when stopping or correcting the agent",
  usage: "dim q repeats [words-per-phrase]",
  window: "m.ts",
  run: (db, ctx) => {
    const size = ctx.arg && /^\d+$/.test(ctx.arg) ? Number(ctx.arg) : 4;
    const w = window("m.ts", ctx);
    const rows = table(
      db,
      `SELECT m.id, m.session_id, coalesce(m.user_feedback, m.text, '') AS said
       FROM message m
       WHERE m.role = 'user'
         AND (${stoppedByOwner()} OR m.prompt_source IN ('typed','queued'))
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
            "instruction — read the sessions before promoting one into guidance every session will load. " +
            "Both tools mark a typed prompt; only Claude marks a stop, so the stopped half is Claude's alone.",
    };
  },
};
