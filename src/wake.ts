import type { Database } from "bun:sqlite";

/**
 * Claude Code adds a SessionStart hook's plain-text stdout to the session as
 * context the model can act on, which is the one channel here that reaches a
 * session without anyone deciding to ask for it. Everything a query can answer
 * is still a query; this carries only what a cold start cannot work out and
 * would otherwise spend its first turns rediscovering.
 */
export type Wake = {
  sessionId: string;
  endedAt: string | null;
  endReason: string | null;
  next: string | null;
};

/** Every line costs tokens in every session, so the block states the budget it is held to. */
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
 * The last session in this directory that left a Next, not simply the last one.
 * The most recent row is usually the session doing the asking — still running,
 * ended in no way, holding no handoff — and a session that stopped without
 * leaving anything has nothing worth a token in every start that follows.
 *
 * A handoff is printed into the transcript before it is pasted, so the session
 * that wrote one holds the text whether or not anyone carried it forward.
 */
export function readWake(db: Database, cwd: string): Wake | null {
  const session = db
    .prepare<{ id: string; ended_at: string | null; end_reason: string | null; text: string }, [string]>(
      `SELECT s.id AS id, s.ended_at AS ended_at, s.end_reason AS end_reason, m.text AS text
       FROM session s
       JOIN message m ON m.session_id = s.id
       WHERE s.parent_id IS NULL AND s.cwd = ?
         AND m.role = 'assistant' AND m.text LIKE '%# Handoff%'
       ORDER BY m.ts DESC LIMIT 1`,
    )
    .get(cwd);
  if (!session) return null;

  return {
    sessionId: session.id,
    endedAt: session.ended_at,
    endReason: session.end_reason,
    next: nextSection(session.text),
  };
}

/** Empty when there is nothing a cold start does not already know: silence costs no tokens. */
export function renderWake(wake: Wake | null): string {
  if (!wake?.next) return "";
  const id = wake.sessionId.slice(0, 8);
  return [
    `The last session in this directory (${id}) left this Next:`,
    wake.next,
    `\`dim q resume ${id}\` has the branch, the files in play and the last pushback.`,
  ].join("\n");
}
