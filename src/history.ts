import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readChunk } from "./chunk";
import { claudeProjectsDir, codexDir, type Env } from "./paths";
import type { Tool } from "./tools";

export type HistoryReport = { read: number; orphans: number };

type ClaudeHistoryLine = { display?: string; timestamp?: number; project?: string; sessionId?: string };
type CodexHistoryLine = { text?: string; ts?: number; session_id?: string };

export function claudeHistoryPath(env: Env = process.env): string {
  return join(dirname(claudeProjectsDir(env)), "history.jsonl");
}

export function codexHistoryPath(env: Env = process.env): string {
  return join(codexDir(env), "history.jsonl");
}

/**
 * Both files are a flat log of what was typed, with no cursor of their own: they
 * are small and fully re-read each sync, and the primary key makes that a no-op.
 * Only prompts whose session has no transcript are stored — a prompt that is
 * already a `message` row would be a second, worse copy of it.
 */
export function ingestHistory(db: Database, env: Env = process.env): HistoryReport {
  const report: HistoryReport = { read: 0, orphans: 0 };
  const insert = db.prepare<void, [string, string, string, string | null, string]>(
    `INSERT INTO orphan_prompt (tool, session_id, ts, project, text)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  const known = new Set(
    db
      .prepare<{ id: string }, []>("SELECT id FROM session")
      .all()
      .map((r) => r.id),
  );

  const load = (
    path: string,
    tool: Tool,
    pick: (line: string) => { sessionId?: string; ts?: number; text?: string; project?: string },
  ): void => {
    if (!existsSync(path)) return;
    const { lines } = readChunk(path, 0);
    const rows: [string, string, string, string | null, string][] = [];
    for (const raw of lines) {
      if (raw.length === 0) continue;
      report.read += 1;
      let f: ReturnType<typeof pick>;
      try {
        f = pick(raw);
      } catch {
        continue;
      }
      if (!f.sessionId || !f.text || f.ts == null || known.has(f.sessionId)) continue;
      rows.push([tool, f.sessionId, new Date(f.ts).toISOString(), f.project ?? null, f.text]);
    }
    db.transaction(() => {
      for (const row of rows) insert.run(...row);
    })();
    report.orphans += rows.length;
  };

  load(claudeHistoryPath(env), "claude", (raw) => {
    const l = JSON.parse(raw) as ClaudeHistoryLine;
    return { sessionId: l.sessionId, ts: l.timestamp, text: l.display, project: l.project };
  });
  // Codex records seconds where Claude records milliseconds.
  load(codexHistoryPath(env), "codex", (raw) => {
    const l = JSON.parse(raw) as CodexHistoryLine;
    return { sessionId: l.session_id, ts: l.ts == null ? undefined : l.ts * 1000, text: l.text };
  });

  return report;
}
