import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import type { Replay, Rewrite } from "./git-rebase-contract";
import { latestOrderCommit } from "./order-commits";
import {
  insertOrderEnvironment,
  type OrderCheck,
  recordOrderCheckInTransaction,
  recordRewrittenCommits,
} from "./order-evidence";
import { now } from "./order-ledger";
import { assertOrderRunning } from "./order-status";
import type { ShipTeardown } from "./ship-cleanup";

export type ShipRun = { rebased?: { rewrite: Rewrite; check: OrderCheck } } & (
  | { outcome: "landed" }
  | { outcome: "refused"; code: string | null; reason: string }
  | { outcome: "conflict"; replay: Omit<Replay, "worktree">; paths: string[]; stoppedAt: string }
);

export function recordShipRun(db: Database, orderId: string, run: ShipRun, at = now()): number {
  assertOrderRunning(db, orderId);
  return writeTransaction(db, () => {
    const { rebased } = run;
    const head = rebased ? rebased.rewrite.newHead : latestOrderCommit(db, orderId)?.sha;
    if (!head) throw new Error(`order ${orderId} records no commit, so a ship run has no head`);
    const replay = run.outcome === "conflict" ? run.replay : rebased?.rewrite;
    const checkId = rebased
      ? recordOrderCheckInTransaction(db, orderId, rebased.check, rebased.rewrite.newHead, at)
      : null;
    const written = db.run(
      `INSERT INTO factory_order_ship_run
         (order_id, outcome, code, reason, conflict_paths, stopped_at, old_base, new_base, old_head,
          patch_equal, check_id, head, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        run.outcome,
        run.outcome === "refused" ? run.code : null,
        run.outcome === "refused" ? run.reason : null,
        run.outcome === "conflict" ? JSON.stringify(run.paths) : null,
        run.outcome === "conflict" ? run.stoppedAt : null,
        replay?.oldBase ?? null,
        replay?.newBase ?? null,
        replay?.oldHead ?? null,
        rebased ? Number(rebased.rewrite.patchEqual) : null,
        checkId,
        head,
        at,
      ],
    );
    const id = Number(written.lastInsertRowid);
    if (rebased) recordRewrittenCommits(db, orderId, id, rebased.rewrite, at);
    db.run("UPDATE factory_order SET updated_at = ? WHERE id = ?", [at, orderId]);
    return id;
  });
}

export function recordShipCleanup(
  db: Database,
  orderId: string,
  shipRunId: number,
  { teardown, worktreeKept, branchKept }: ShipTeardown,
  at = now(),
): void {
  writeTransaction(db, () => {
    const updated = db.run(
      `UPDATE factory_order_ship_run SET worktree_kept = ?, branch_kept = ?
       WHERE id = ? AND order_id = ? AND outcome = 'landed'`,
      [worktreeKept ?? null, branchKept ?? null, shipRunId, orderId],
    );
    if (updated.changes !== 1) throw new Error(`order ${orderId} has no landed ship run ${shipRunId}`);
    if (teardown) insertOrderEnvironment(db, orderId, teardown, at);
  });
}
