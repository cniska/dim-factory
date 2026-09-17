import type { Database } from "bun:sqlite";

/**
 * The cap the `wake` block is held to: the Next is delivered on every session
 * start, and every line of it is paid for there.
 */
const NEXT_MAX_CHARS = 700;

/** The handoff's own heading, as the skill writes it. */
const NEXT_HEADING = "## Next";

export function nextSection(handoff: string): string | null {
  const start = handoff.indexOf(NEXT_HEADING);
  if (start === -1) return null;
  const body = handoff.slice(start + NEXT_HEADING.length);
  const end = body.indexOf("\n## ");
  const section = (end === -1 ? body : body.slice(0, end)).trim();
  if (section === "") return null;
  return section.length > NEXT_MAX_CHARS ? `${section.slice(0, NEXT_MAX_CHARS).trimEnd()}…` : section;
}

/**
 * What makes a message a handoff: the heading at the start of a line, together
 * with a `## Next` that parses. The heading alone also matches every session
 * that merely discussed one, and the `handoff` skill's attribution misses the
 * quarter written under no skill. See docs/recall.md.
 */
const TITLE_LINE = /^# Handoff.*$/m;

/** The whole heading line, which is the key both sides of the chain share. */
export function handoffTitle(text: string): string | null {
  const line = text.match(TITLE_LINE);
  if (!line) return null;
  return nextSection(text) === null ? null : line[0].trim();
}

/** The Next this handoff left, and null for a message that is not one. */
export function handoffNext(text: string): string | null {
  return handoffTitle(text) === null ? null : nextSection(text);
}

export type Handoff = {
  messageId: string;
  sessionId: string;
  /** assistant where the handoff was printed, user where it was pasted forward. */
  role: "user" | "assistant";
  ts: string;
  title: string;
};

/** Both halves of every chain, oldest first, which is the order the link pass walks. */
export function readHandoffs(db: Database): Handoff[] {
  const rows = db
    .prepare<{ id: string; session_id: string; role: "user" | "assistant"; ts: string; text: string }, []>(
      `SELECT m.id AS id, m.session_id AS session_id, m.role AS role, m.ts AS ts, m.text AS text
       FROM message m
       WHERE m.text LIKE '%# Handoff%' AND m.text LIKE '%## Next%'
       ORDER BY m.ts`,
    )
    .all();
  const out: Handoff[] = [];
  for (const row of rows) {
    const title = handoffTitle(row.text);
    if (title) {
      out.push({ messageId: row.id, sessionId: row.session_id, role: row.role, ts: row.ts, title });
    }
  }
  return out;
}

export type HandoffLinkReport = { pasted: number; linked: number };

/**
 * The edge from the session that printed a handoff to the one it was pasted
 * into. A printer in the same session is not an edge — that is a session
 * quoting its own handoff back — and a printer after the paste cannot be the
 * source, so the writer is the nearest preceding printer in another session.
 * Around one in five pastes finds none, because the session that wrote it was
 * pruned before its transcript was ever read.
 *
 * Derived, so it carries no foreign key and is replaced whole on every sync,
 * as `repo_file` is: a link is only as good as the messages present now.
 */
export function linkHandoffs(db: Database): HandoffLinkReport {
  const all = readHandoffs(db);
  const printed = new Map<string, Handoff[]>();
  for (const h of all) {
    if (h.role !== "assistant") continue;
    const byTitle = printed.get(h.title);
    if (byTitle) byTitle.push(h);
    else printed.set(h.title, [h]);
  }

  const report: HandoffLinkReport = { pasted: 0, linked: 0 };
  const insert = db.prepare(
    `INSERT INTO handoff_link (to_message, to_session, to_ts, from_message, from_session, from_ts, title)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  db.transaction(() => {
    db.run("DELETE FROM handoff_link");
    for (const paste of all) {
      if (paste.role !== "user") continue;
      report.pasted += 1;
      // readHandoffs is ordered by ts, so the candidates are too, and the last
      // one before the paste is the nearest.
      const writer = (printed.get(paste.title) ?? [])
        .filter((h) => h.sessionId !== paste.sessionId && h.ts < paste.ts)
        .at(-1);
      if (!writer) continue;
      insert.run(
        paste.messageId,
        paste.sessionId,
        paste.ts,
        writer.messageId,
        writer.sessionId,
        writer.ts,
        paste.title,
      );
      report.linked += 1;
    }
  })();
  return report;
}
