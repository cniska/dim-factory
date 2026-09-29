import type { Database } from "bun:sqlite";
import type { Replay } from "./ship-rebase";

export type OrderCommit = { sha: string; subject: string; recordedAt: string };

export function currentOrderCommits(db: Database, orderId: string): OrderCommit[] {
  return db
    .query<OrderCommit, [string]>(
      `SELECT c.sha, c.subject, c.recorded_at AS recordedAt
       FROM factory_order_commit c
       WHERE c.order_id = ? AND NOT EXISTS (
         SELECT 1 FROM factory_order_commit later WHERE later.order_id = c.order_id AND later.retires = c.sha
       )
       ORDER BY c.id`,
    )
    .all(orderId);
}

export type RecordedConflict = Omit<Replay, "worktree"> & {
  shipRun: number;
  paths: string[];
  stoppedAt: string;
};

export function pendingRebaseConflict(db: Database, orderId: string): RecordedConflict | null {
  const row = db
    .query<Omit<RecordedConflict, "paths"> & { paths: string }, [string]>(
      `SELECT r.id AS shipRun, r.old_base AS oldBase, r.new_base AS newBase, r.old_head AS oldHead,
              r.stopped_at AS stoppedAt, r.conflict_paths AS paths
       FROM factory_order_ship_run r
       WHERE r.order_id = ? AND r.outcome = 'conflict'
         AND r.id = (SELECT max(latest.id) FROM factory_order_ship_run latest WHERE latest.order_id = r.order_id)
         AND NOT EXISTS (SELECT 1 FROM factory_order_commit c WHERE c.ship_run_id = r.id)`,
    )
    .get(orderId);
  return row ? { ...row, paths: JSON.parse(row.paths) as string[] } : null;
}

export function latestOrderCommit(db: Database, orderId: string): OrderCommit | null {
  return currentOrderCommits(db, orderId).at(-1) ?? null;
}
