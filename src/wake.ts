import type { Database } from "bun:sqlite";
import { checkoutRoot } from "./checkout";
import { handoffNext } from "./handoff";
import { checkTask, formatTask } from "./tasks";

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
  /** Never empty: a session that left nothing is not a wake, it is silence. */
  next: string;
};

/**
 * The last session in this directory that left a Next, not simply the last one.
 * The most recent row is usually the session doing the asking — still running,
 * ended in no way, holding no handoff — and a session that stopped without
 * leaving anything has nothing worth a token in every start that follows.
 *
 * A handoff is printed into the transcript before it is pasted, so the session
 * that wrote one holds the text whether or not anyone carried it forward. A
 * session that quotes a whole handoff back, Next and all, reads as having
 * written it, and what it quotes is usually the live Next anyway.
 */
export function readWake(db: Database, cwd: string): Wake | null {
  // The SQL predicate is a prefilter, not the test: it also matches a session
  // discussing a handoff, and taking one row and parsing afterwards would let
  // such a message shadow the real handoff under it. So the rows are walked
  // newest first and the first one that is a handoff wins.
  const rows = db
    .prepare<{ id: string; ended_at: string | null; end_reason: string | null; text: string }, [string]>(
      `SELECT s.id AS id, s.ended_at AS ended_at, s.end_reason AS end_reason, m.text AS text
       FROM session s
       JOIN message m ON m.session_id = s.id
       WHERE s.parent_id IS NULL AND s.cwd = ?
         AND m.role = 'assistant' AND m.text LIKE '%# Handoff%' AND m.text LIKE '%## Next%'
       ORDER BY m.ts DESC`,
    )
    .iterate(cwd);

  for (const row of rows) {
    const next = handoffNext(row.text);
    if (next === null) continue;
    return { sessionId: row.id, endedAt: row.ended_at, endReason: row.end_reason, next };
  }
  return null;
}

/**
 * Claude Code adds a SessionStart hook's plain-text stdout to the session as
 * context; Codex takes the same thing only as `hookSpecificOutput.additionalContext`
 * on a SessionStart event and ignores loose text. One block, two envelopes.
 */
export function wireFor(tool: "claude" | "codex", block: string): string {
  if (block === "") return "";
  if (tool === "claude") return block;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block },
  });
}

/**
 * What the repo declares, in one line. A cold start can reach these by opening a
 * manifest, which costs a tool call and its output — more than the line costs,
 * which is the whole test for what goes in here. Running the declared task is
 * what makes a local check the check CI runs, so nothing here is derived from
 * the tool underneath the script.
 */
export function projectLine(dir: string): string {
  const repo = checkoutRoot(dir);
  if (repo === null) return "";
  const declared: string[] = [];
  const check = checkTask(repo);
  const format = formatTask(repo);
  if (check) declared.push(`check \`${check.command}\``);
  if (format) declared.push(`format \`${format.command}\``);
  return declared.length === 0 ? "" : `This repo declares: ${declared.join(", ")}.`;
}

/**
 * Empty when there is nothing a cold start does not already know: silence costs
 * no tokens. A repo that declares a task is never silent, because that line is
 * worth reading whether or not a session left anything behind.
 */
export function renderWake(wake: Wake | null, repo: string): string {
  const project = projectLine(repo);
  if (!wake) return project;
  const id = wake.sessionId.slice(0, 8);
  return [
    `The last session in this directory (${id}) left this Next:`,
    wake.next,
    `\`dim q resume ${id}\` has the branch, the files in play and the last pushback.`,
    ...(project ? [project] : []),
  ].join("\n");
}
