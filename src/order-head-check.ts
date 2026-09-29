import type { Database } from "bun:sqlite";
import { latestOrderCommit } from "./order-commits";
import { fail } from "./order-contract";

export type FailedCheck = { command: string; exitCode: number; result: string };

function headCheck(db: Database, orderId: string): FailedCheck | null {
  const head = latestOrderCommit(db, orderId)?.sha ?? null;
  return db
    .query<FailedCheck, [string, string | null, string | null]>(
      `SELECT command, exit_code AS exitCode, result FROM factory_order_check
       WHERE order_id = ? AND (? IS NULL OR head_sha = ?) ORDER BY id DESC LIMIT 1`,
    )
    .get(orderId, head, head);
}

export function failedHeadCheck(db: Database, orderId: string): FailedCheck | null {
  const check = headCheck(db, orderId);
  return check && check.exitCode !== 0 ? check : null;
}

export function assertChecked(db: Database, orderId: string): void {
  if (headCheck(db, orderId)?.exitCode === 0) return;
  throw fail("order_not_checked", { orderId });
}
