import type { Database } from "bun:sqlite";
import { finishAttempt, openAttempt } from "./order-attempt";
import { latestOrderCommit } from "./order-commits";
import { appendOrderEventInTransaction, assertChecked, now } from "./order-ledger";
import { assertOrderActive, OrderNotDone } from "./order-status";
import type { Station } from "./station";
import type { PlanSlice } from "./station-plan-artifact";

export type StoredArtifact = {
  id: number;
  revision: number;
  body: string;
  headSha: string | null;
  reviewId: number | null;
};

const ARTIFACT_COLUMNS = "id, revision, body, head_sha AS headSha, review_id AS reviewId";

export function latestArtifact(db: Database, orderId: string, kind: Station): StoredArtifact | null {
  return db
    .query<StoredArtifact, [string, Station]>(
      `SELECT ${ARTIFACT_COLUMNS} FROM factory_order_artifact
       WHERE order_id = ? AND kind = ? ORDER BY revision DESC LIMIT 1`,
    )
    .get(orderId, kind);
}

export function writeArtifactInTransaction(
  db: Database,
  orderId: string,
  artifact: { kind: Station; body: string; headSha: string | null; reviewId: number | null },
  worker: string,
  at: string,
): number {
  const revision = (db
    .query<{ revision: number }, [string, Station]>(
      "SELECT coalesce(max(revision), 0) + 1 AS revision FROM factory_order_artifact WHERE order_id = ? AND kind = ?",
    )
    .get(orderId, artifact.kind)?.revision ?? 1) as number;
  const written = db.run(
    `INSERT INTO factory_order_artifact (order_id, kind, revision, body, head_sha, review_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [orderId, artifact.kind, revision, artifact.body, artifact.headSha, artifact.reviewId],
  );
  const artifactId = Number(written.lastInsertRowid);
  appendOrderEventInTransaction(db, orderId, { kind: "artifact_written", worker, artifactId }, at);
  return artifactId;
}

export type ReturnedOrderArtifact = { reason: string; artifactId: number; body: string };

export function returnedOrderArtifact(
  db: Database,
  orderId: string,
  station: Station,
): ReturnedOrderArtifact | null {
  return db
    .query<ReturnedOrderArtifact, [string, Station]>(
      `SELECT e.reason, a.id AS artifactId, a.body
       FROM factory_order_event e
       JOIN factory_order_artifact a ON a.id = e.artifact_id
       WHERE e.order_id = ? AND e.kind = 'artifact_returned' AND a.kind = ?
         AND NOT EXISTS (
           SELECT 1 FROM factory_order_event w
           JOIN factory_order_artifact wa ON wa.id = w.artifact_id
           WHERE w.order_id = e.order_id AND w.kind = 'artifact_written' AND wa.kind = a.kind
             AND w.id > e.id
         )
       ORDER BY e.id DESC LIMIT 1`,
    )
    .get(orderId, station);
}

export function recordOrderPlan(
  db: Database,
  orderId: string,
  body: string,
  worker: string,
  slices: readonly PlanSlice[],
  at = now(),
): number {
  assertOrderActive(db, orderId);
  if (body.trim() === "") throw new Error("plan body must not be empty");
  if (slices.length === 0) throw new Error("plan must contain at least one slice");
  return db.transaction(() => {
    const artifactId = writeArtifactInTransaction(
      db,
      orderId,
      { kind: "plan", body, headSha: null, reviewId: null },
      worker,
      at,
    );
    for (const [index, slice] of slices.entries()) {
      db.run("INSERT INTO factory_order_slice (artifact_id, ordinal, title, outcome) VALUES (?, ?, ?, ?)", [
        artifactId,
        index + 1,
        slice.title,
        slice.outcome,
      ]);
    }
    return artifactId;
  })();
}

const APPROVED_PLAN = `EXISTS (
  SELECT 1 FROM factory_order_event e WHERE e.kind = 'artifact_approved' AND e.artifact_id = p.id
)`;

export function recordOrderBuild(
  db: Database,
  orderId: string,
  body: string,
  headSha: string,
  worker: string,
  at = now(),
): number {
  assertOrderActive(db, orderId);
  if (!openAttempt(db, orderId)) {
    throw new OrderNotDone(
      "build_artifact_before_final_slice",
      `order ${orderId} has no active final build turn`,
    );
  }
  const next = nextOrderSlice(db, orderId);
  if (next) {
    const last = db
      .query<{ ordinal: number }, [string]>(
        `SELECT max(s.ordinal) AS ordinal
         FROM factory_order_slice s
         JOIN factory_order_artifact p ON p.id = s.artifact_id
         WHERE p.order_id = ? AND ${APPROVED_PLAN}`,
      )
      .get(orderId);
    if (last?.ordinal !== next.ordinal) {
      throw new OrderNotDone(
        "build_artifact_before_final_slice",
        `order ${orderId} must finish its final slice before recording a Build artifact`,
      );
    }
  }
  if (body.trim() === "") throw new Error("build artifact body must not be empty");
  if (headSha.trim() === "") throw new Error("build artifact head must not be empty");
  return db.transaction(() =>
    writeArtifactInTransaction(db, orderId, { kind: "build", body, headSha, reviewId: null }, worker, at),
  )();
}

export type OrderSlice = PlanSlice & { id: number; ordinal: number };

export function nextOrderSlice(db: Database, orderId: string): OrderSlice | null {
  return db
    .query<OrderSlice, [string]>(
      `SELECT s.id, s.ordinal, s.title, s.outcome
       FROM factory_order_slice s
       JOIN factory_order_artifact p ON p.id = s.artifact_id
       WHERE p.order_id = ? AND ${APPROVED_PLAN} AND NOT EXISTS (
         SELECT 1 FROM factory_order_slice_completion c WHERE c.slice_id = s.id
       )
       ORDER BY p.revision DESC, s.ordinal
       LIMIT 1`,
    )
    .get(orderId);
}

export function completeOrderSlice(
  db: Database,
  orderId: string,
  sliceId: number,
  worker: string,
  at = now(),
): void {
  db.transaction(() => {
    assertOrderActive(db, orderId);
    const slice = db
      .query<{ id: number }, [string, number]>(
        `SELECT s.id FROM factory_order_slice s
         JOIN factory_order_artifact p ON p.id = s.artifact_id
         WHERE p.order_id = ? AND s.id = ? AND ${APPROVED_PLAN}`,
      )
      .get(orderId, sliceId);
    if (!slice) throw new Error(`slice ${sliceId} does not belong to order ${orderId}'s approved plan`);
    const next = nextOrderSlice(db, orderId);
    if (!next || next.id !== sliceId)
      throw new Error(`slice ${sliceId} is not the next slice for order ${orderId}`);
    db.run("INSERT INTO factory_order_slice_completion (slice_id, worker, completed_at) VALUES (?, ?, ?)", [
      sliceId,
      worker,
      at,
    ]);
    finishAttempt(db, orderId, "succeeded", undefined, at);
  })();
}

export function completeOrderBuildFollowup(
  db: Database,
  orderId: string,
  priorArtifactId: number,
  at = now(),
): void {
  db.transaction(() => {
    assertOrderActive(db, orderId);
    if (nextOrderSlice(db, orderId) !== null) {
      throw new Error(`order ${orderId} still has an incomplete build slice`);
    }
    assertChecked(db, orderId);
    const commit = latestOrderCommit(db, orderId);
    const artifact = commit
      ? db
          .query(
            "SELECT 1 FROM factory_order_artifact WHERE order_id = ? AND kind = 'build' AND head_sha = ? AND id > ?",
          )
          .get(orderId, commit.sha, priorArtifactId)
      : null;
    if (!artifact) throw new Error(`order ${orderId} has no Build artifact from this build turn`);
    finishAttempt(db, orderId, "succeeded", undefined, at);
  })();
}
