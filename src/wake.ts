import type { Database } from "bun:sqlite";
import { checkoutRoot } from "./checkout";
import type { Tool } from "./tools";
import { checkCommand, formatCommand } from "./workspace-commands";

export type Wake = {
  sessionId: string;
  endedAt: string | null;
  endReason: string | null;
  next: string;
};

export function readWake(db: Database, cwd: string): Wake | null {
  const rows = db
    .prepare<{ id: string; ended_at: string | null; end_reason: string | null; next: string }, [string]>(
      `SELECT s.id AS id, s.ended_at AS ended_at, s.end_reason AS end_reason, h.next AS next
       FROM session s
       JOIN factory_handoff h ON h.session_id = s.id
       WHERE s.parent_id IS NULL AND s.cwd = ?
         AND h.role = 'assistant'
       ORDER BY h.ts DESC`,
    )
    .iterate(cwd);

  for (const row of rows) {
    return { sessionId: row.id, endedAt: row.ended_at, endReason: row.end_reason, next: row.next };
  }
  return null;
}

export function wireFor(tool: Tool, block: string): string {
  if (block === "") return "";
  if (tool === "claude") return block;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block },
  });
}

export function projectLine(dir: string): string {
  const repo = checkoutRoot(dir);
  if (repo === null) return "";
  const declared: string[] = [];
  const check = checkCommand(repo);
  const format = formatCommand(repo);
  if (check) declared.push(`check \`${check.command}\``);
  if (format) declared.push(`format \`${format.command}\``);
  return declared.length === 0 ? "" : `This repo declares: ${declared.join(", ")}.`;
}

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
