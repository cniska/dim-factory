import type { Database } from "bun:sqlite";

const NEXT_MAX_CHARS = 700;

export function nextSection(handoff: string): string | null {
  const match = handoff.match(/^## Next[ \t]*$/m);
  if (!match || match.index === undefined) return null;
  return sectionAfter(handoff, match.index + match[0].length);
}

function sectionAfter(text: string, start: number): string | null {
  const body = text.slice(start);
  const end = body.search(/^## /m);
  const section = (end === -1 ? body : body.slice(0, end)).trim();
  if (section === "") return null;
  return section.length > NEXT_MAX_CHARS ? `${section.slice(0, NEXT_MAX_CHARS).trimEnd()}…` : section;
}

const TITLE_LINE = /^# Handoff(?:[ \t]+.*)?[ \t]*$/m;

export function handoffTitle(text: string): string | null {
  const line = text.match(TITLE_LINE);
  if (!line || line.index === undefined) return null;
  const rest = text.slice(line.index + line[0].length);
  const next = rest.match(/^## Next[ \t]*$/m);
  if (!next || next.index === undefined) return null;
  return sectionAfter(rest, next.index + next[0].length) === null ? null : line[0].trim();
}

export function handoffNext(text: string): string | null {
  const line = text.match(TITLE_LINE);
  if (!line || line.index === undefined) return null;
  const rest = text.slice(line.index + line[0].length);
  const next = rest.match(/^## Next[ \t]*$/m);
  if (!next || next.index === undefined) return null;
  return sectionAfter(rest, next.index + next[0].length);
}

export type Handoff = {
  messageId: string;
  sessionId: string;
  role: "user" | "assistant";
  ts: string;
  title: string;
  next: string;
};

export type HandoffBackfillReport = { found: number };

export function backfillHandoffs(db: Database): HandoffBackfillReport {
  const rows = db
    .prepare<{ id: string; session_id: string; role: "user" | "assistant"; ts: string; text: string }, []>(
      `SELECT id, session_id, role, ts, text FROM message
       WHERE text IS NOT NULL ORDER BY ts, id`,
    )
    .all();
  const insert = db.prepare(
    `INSERT INTO factory_handoff (message_id, session_id, role, ts, title, next)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let found = 0;
  db.transaction(() => {
    db.run("DELETE FROM factory_handoff");
    for (const row of rows) {
      const title = handoffTitle(row.text);
      const next = handoffNext(row.text);
      if (!title || !next) continue;
      insert.run(row.id, row.session_id, row.role, row.ts, title, next);
      found += 1;
    }
  })();
  return { found };
}

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
      out.push({
        messageId: row.id,
        sessionId: row.session_id,
        role: row.role,
        ts: row.ts,
        title,
        next: handoffNext(row.text) as string,
      });
    }
  }
  return out;
}

export type HandoffLinkReport = { pasted: number; linked: number };

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
