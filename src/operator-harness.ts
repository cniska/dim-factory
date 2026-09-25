import type { Database } from "bun:sqlite";
import { type HarnessName, isHarness } from "./harness-name";

/** The harness a worker's own session runs in, as that session's hooks recorded it. */
export function recordedHarness(db: Database, worker: string): HarnessName | null {
  const tool = db
    .query<{ tool: string }, [string]>(
      `SELECT h.tool FROM hook_event h
       JOIN factory_worker w ON w.session_id = h.session_id
       WHERE w.name = ? AND h.event = 'session_start'
       ORDER BY h.ts LIMIT 1`,
    )
    .get(worker)?.tool;
  return isHarness(tool) ? tool : null;
}
