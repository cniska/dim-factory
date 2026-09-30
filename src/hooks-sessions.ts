import type { Database } from "bun:sqlite";

export type OpenSession = {
  readonly id: string;
  readonly tool: string;
  readonly harnessPid: number;
  readonly cwd: string | null;
  readonly startedAt: string;
};

type OpenSessionRow = {
  readonly session_id: string;
  readonly tool: string;
  readonly harness_pid: number;
  readonly cwd: string | null;
  readonly ts: string;
};

export function openSessionsUnder(db: Database, harnessPids: readonly number[]): readonly OpenSession[] {
  if (harnessPids.length === 0) return [];
  return db
    .query<OpenSessionRow, number[]>(
      `SELECT started.session_id, started.tool, started.harness_pid, started.cwd, started.ts
       FROM hook_event started
       WHERE started.event = 'session_start'
         AND started.harness_pid IN (${harnessPids.map(() => "?").join(", ")})
         AND NOT EXISTS (
           SELECT 1 FROM hook_event ended
           WHERE ended.session_id = started.session_id AND ended.event = 'session_end' AND ended.ts >= started.ts)
       ORDER BY started.ts DESC`,
    )
    .all(...harnessPids)
    .map((row) => ({
      id: row.session_id,
      tool: row.tool,
      harnessPid: row.harness_pid,
      cwd: row.cwd,
      startedAt: row.ts,
    }));
}
