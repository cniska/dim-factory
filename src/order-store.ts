import type { Database } from "bun:sqlite";
import type {
  Order,
  OrderArtifact,
  OrderCheckRecord,
  OrderCommitRecord,
  OrderFindingRecord,
  OrderReviewRecord,
  OrderShipRunRecord,
  OrderSliceRecord,
} from "./order-contract";
import { type OrderStatus, orderStatusSql } from "./order-status";
import type { Station } from "./station";

type ArtifactRow = {
  id: number;
  kind: Station;
  revision: number;
  head_sha: string | null;
  review_id: number | null;
  approved: number;
  returned: number;
};

export function loadOrder(db: Database, orderId: string): Order {
  const row = db
    .query<{ status: OrderStatus }, [string]>(
      `SELECT ${orderStatusSql("o.id")} AS status FROM factory_order o WHERE o.id = ?`,
    )
    .get(orderId);
  if (!row) throw new Error(`order not found: ${orderId}`);
  const artifacts = db
    .query<ArtifactRow, [string]>(
      `SELECT a.id, a.kind, a.revision, a.head_sha, a.review_id,
              EXISTS (SELECT 1 FROM factory_order_event e WHERE e.kind = 'artifact_approved' AND e.artifact_id = a.id) AS approved,
              EXISTS (SELECT 1 FROM factory_order_event e WHERE e.kind = 'artifact_returned' AND e.artifact_id = a.id) AS returned
       FROM factory_order_artifact a WHERE a.order_id = ? ORDER BY a.id`,
    )
    .all(orderId)
    .map(
      (a): OrderArtifact => ({
        id: a.id,
        kind: a.kind,
        revision: a.revision,
        headSha: a.head_sha,
        reviewId: a.review_id,
        approved: a.approved === 1,
        returned: a.returned === 1,
      }),
    );
  const slices = db
    .query<{ id: number; artifactId: number; ordinal: number; done: number }, [string]>(
      `SELECT s.id, s.artifact_id AS artifactId, s.ordinal,
              EXISTS (SELECT 1 FROM factory_order_slice_completion c WHERE c.slice_id = s.id) AS done
       FROM factory_order_slice s JOIN factory_order_artifact p ON p.id = s.artifact_id
       WHERE p.order_id = ? ORDER BY s.artifact_id, s.ordinal`,
    )
    .all(orderId)
    .map((s): OrderSliceRecord => ({ ...s, done: s.done === 1 }));
  const commits = db
    .query<OrderCommitRecord, [string]>(
      `SELECT id, sha, retires, ship_run_id AS shipRunId FROM factory_order_commit WHERE order_id = ? ORDER BY id`,
    )
    .all(orderId);
  const shipRuns = db
    .query<OrderShipRunRecord, [string]>(
      `SELECT id, outcome, old_head AS oldHead, patch_equal AS patchEqual
       FROM factory_order_ship_run WHERE order_id = ? ORDER BY id`,
    )
    .all(orderId);
  const checks = db
    .query<OrderCheckRecord, [string]>(
      "SELECT id, head_sha AS headSha, exit_code AS exitCode FROM factory_order_check WHERE order_id = ? ORDER BY id",
    )
    .all(orderId);
  const reviews = db
    .query<OrderReviewRecord, [string]>(
      "SELECT id, head_sha AS headSha FROM factory_order_review WHERE order_id = ? ORDER BY id",
    )
    .all(orderId);
  const findings = db
    .query<{ id: number; reviewId: number; answered: number }, [string]>(
      `SELECT f.id, f.review_id AS reviewId,
              EXISTS (SELECT 1 FROM factory_order_finding_answer a WHERE a.finding_id = f.id) AS answered
       FROM factory_order_finding f JOIN factory_order_review r ON r.id = f.review_id
       WHERE r.order_id = ? ORDER BY f.id`,
    )
    .all(orderId)
    .map((f): OrderFindingRecord => ({ ...f, answered: f.answered === 1 }));
  return { id: orderId, status: row.status, artifacts, slices, commits, shipRuns, checks, reviews, findings };
}
