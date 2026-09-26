import type { Database } from "bun:sqlite";
import type { Replay } from "./ship-rebase";

export type OrderCommit = { sha: string; subject: string; recordedAt: string };

export function currentOrderCommits(db: Database, orderId: string): OrderCommit[] {
  return db
    .query<OrderCommit, [string]>(
      `SELECT c.sha, c.subject, c.recorded_at AS recordedAt
       FROM factory_order_commit c
       JOIN factory_order_event e
         ON e.order_id = c.order_id AND e.kind IN ('commit_created', 'commit_rewritten') AND e.commit_sha = c.sha
       WHERE c.order_id = ? AND c.sha NOT IN (
         SELECT json_extract(retired.evidence, '$.from') FROM factory_order_event retired
         WHERE retired.order_id = c.order_id AND retired.kind = 'commit_rewritten'
       )
       ORDER BY e.id`,
    )
    .all(orderId);
}

export type RecordedConflict = Omit<Replay, "worktree"> & { paths: string[]; stoppedAt: string };

export function pendingRebaseConflict(db: Database, orderId: string): RecordedConflict | null {
  const row = db
    .query<{ evidence: string }, [string]>(
      `SELECT e.evidence FROM factory_order_event e
       WHERE e.order_id = ? AND e.kind = 'ship_failed'
         AND json_extract(e.evidence, '$.code') = 'ship_rebase_conflict'
         AND e.id > coalesce((
           SELECT max(rewritten.id) FROM factory_order_event rewritten
           WHERE rewritten.order_id = e.order_id AND rewritten.kind = 'commit_rewritten'
         ), 0)
       ORDER BY e.id DESC LIMIT 1`,
    )
    .get(orderId);
  if (!row) return null;
  const evidence = JSON.parse(row.evidence) as {
    oldBase: string;
    newBase: string;
    oldHead: string;
    stoppedAt: string;
    paths: string;
  };
  return {
    oldBase: evidence.oldBase,
    newBase: evidence.newBase,
    oldHead: evidence.oldHead,
    stoppedAt: evidence.stoppedAt,
    paths: JSON.parse(evidence.paths) as string[],
  };
}

export function latestOrderCommit(db: Database, orderId: string): OrderCommit | null {
  return currentOrderCommits(db, orderId).at(-1) ?? null;
}

export function rewrittenHead(db: Database, orderId: string, sha: string): string {
  let current = sha;
  for (const rewrite of db
    .query<{ old_head: string; new_head: string }, [string]>(
      "SELECT old_head, new_head FROM factory_order_rewrite WHERE order_id = ? ORDER BY id",
    )
    .all(orderId)) {
    if (rewrite.old_head === current) current = rewrite.new_head;
  }
  return current;
}

export function carriedThroughRewrites(db: Database, orderId: string, sha: string): string | null {
  let current = sha;
  for (const rewrite of db
    .query<{ old_head: string; new_head: string; patch_equal: number }, [string]>(
      "SELECT old_head, new_head, patch_equal FROM factory_order_rewrite WHERE order_id = ? ORDER BY id",
    )
    .all(orderId)) {
    if (rewrite.old_head !== current) continue;
    if (rewrite.patch_equal !== 1) return null;
    current = rewrite.new_head;
  }
  return current;
}
