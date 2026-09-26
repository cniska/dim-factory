import type { Database } from "bun:sqlite";

export type FailedCheck = { command: string; exitCode: number; result: string | null };

export function failedHeadCheck(db: Database, orderId: string): FailedCheck | null {
  const check = db
    .query<FailedCheck, [string]>(
      `SELECT c.command, c.exit_code AS exitCode, c.result FROM factory_order_check c
       JOIN factory_order_event e ON e.check_id = c.id AND e.kind = 'check_finished'
       WHERE e.order_id = ? AND e.id > coalesce((
         SELECT max(commit_event.id) FROM factory_order_event commit_event
         WHERE commit_event.order_id = e.order_id AND commit_event.kind IN ('commit_created', 'commit_rewritten')
       ), 0)
       ORDER BY e.id DESC LIMIT 1`,
    )
    .get(orderId);
  return check && check.exitCode !== 0 ? check : null;
}
