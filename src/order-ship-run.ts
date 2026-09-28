import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { latestOrderCommit } from "./order-commits";
import { type OrderCheck, recordOrderCheckInTransaction, recordRewrittenCommits } from "./order-evidence";
import { now } from "./order-ledger";
import { assertOrderRunning } from "./order-status";
import type { ShipCleanup } from "./ship-cleanup";
import type { Replay, Rewrite } from "./ship-rebase";

export type ShipRun = { rebased?: { rewrite: Rewrite; check: OrderCheck } } & (
  | ({ outcome: "landed" } & ShipCleanup)
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
          patch_equal, check_id, head, worktree_kept, branch_kept, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        run.outcome === "landed" ? (run.worktreeKept ?? null) : null,
        run.outcome === "landed" ? (run.branchKept ?? null) : null,
        at,
      ],
    );
    const id = Number(written.lastInsertRowid);
    if (rebased) recordRewrittenCommits(db, orderId, id, rebased.rewrite, at);
    db.run("UPDATE factory_order SET updated_at = ? WHERE id = ?", [at, orderId]);
    return id;
  });
}
