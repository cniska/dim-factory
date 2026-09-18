import type { Database } from "bun:sqlite";

/** The text in this corpus a person compressed by hand; see docs/recall.md for why only this. */
export type DistilledKind = "next" | "subject" | "correction";

export type Distilled = { kind: DistilledKind; ref: string; text: string };

function nexts(db: Database): Distilled[] {
  const rows = db
    .prepare<{ id: string; next: string }, []>(
      `SELECT message_id AS id, next
       FROM factory_handoff
       WHERE role = 'assistant'`,
    )
    .all();
  const out: Distilled[] = [];
  for (const row of rows) {
    out.push({ kind: "next", ref: row.id, text: row.next });
  }
  return out;
}

function subjects(db: Database, author: string | null): Distilled[] {
  if (!author) return [];
  return db
    .prepare<{ sha: string; subject: string }, [string]>(
      "SELECT sha, subject FROM repo_commit WHERE author = ? AND trim(subject) <> ''",
    )
    .all(author)
    .map((row) => ({ kind: "subject" as const, ref: row.sha, text: row.subject }));
}

function corrections(db: Database): Distilled[] {
  return db
    .prepare<{ id: string; text: string }, []>(
      `SELECT cl.message_id AS id, m.text AS text
       FROM correction_label cl
       JOIN message m ON m.id = cl.message_id
       WHERE cl.label = 'correction' AND m.text IS NOT NULL AND trim(m.text) <> ''`,
    )
    .all()
    .map((row) => ({ kind: "correction" as const, ref: row.id, text: row.text }));
}

export function readDistilled(db: Database, author: string | null): Distilled[] {
  return [...nexts(db), ...subjects(db, author), ...corrections(db)];
}
