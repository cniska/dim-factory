import type { Database } from "bun:sqlite";
import { latestOrderCommit } from "./factory-order-commits";
import {
  appendOrderEventInTransaction,
  assertChecked,
  now,
  recordAttemptFinish,
  setOrderHoldInTransaction,
} from "./factory-order-ledger";
import {
  APPROVAL_HOLD,
  assertOrderBuilding,
  assertOrderWorking,
  BuildApprovalRefused,
  OrderNotDone,
  type OrderStatus,
  PlanApprovalRefused,
} from "./factory-order-status";
import type { PlanSlice } from "./plan-artifact";

export type ArtifactKind = "plan" | "build" | "review";

export type StoredArtifact = {
  id: number;
  revision: number;
  body: string;
  headSha: string | null;
  reviewId: number | null;
};

const ARTIFACT_COLUMNS = "id, revision, body, head_sha AS headSha, review_id AS reviewId";

export function latestArtifact(db: Database, orderId: string, kind: ArtifactKind): StoredArtifact | null {
  return db
    .query<StoredArtifact, [string, ArtifactKind]>(
      `SELECT ${ARTIFACT_COLUMNS} FROM factory_order_artifact
       WHERE order_id = ? AND kind = ? ORDER BY revision DESC LIMIT 1`,
    )
    .get(orderId, kind);
}

export function isArtifactApproved(db: Database, artifactId: number): boolean {
  return (
    db
      .query("SELECT 1 FROM factory_order_event WHERE kind = 'artifact_approved' AND artifact_id = ?")
      .get(artifactId) !== null
  );
}

export function artifactWriter(db: Database, artifactId: number): string {
  const writer = db
    .query<{ worker: string }, [number]>(
      "SELECT worker FROM factory_order_event WHERE kind = 'artifact_written' AND artifact_id = ?",
    )
    .get(artifactId)?.worker;
  if (!writer) throw new Error(`artifact ${artifactId} has no artifact_written event`);
  return writer;
}

export function writeArtifactInTransaction(
  db: Database,
  orderId: string,
  artifact: { kind: ArtifactKind; body: string; headSha: string | null; reviewId: number | null },
  worker: string,
  at: string,
): number {
  const revision = (db
    .query<{ revision: number }, [string, ArtifactKind]>(
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

export function holdForApprovalInTransaction(
  db: Database,
  orderId: string,
  worker: string,
  at: string,
): void {
  setOrderHoldInTransaction(db, orderId, APPROVAL_HOLD, at);
  appendOrderEventInTransaction(
    db,
    orderId,
    { kind: "hold_set", worker, holdType: APPROVAL_HOLD, evidence: { hold: APPROVAL_HOLD } },
    at,
  );
}

export function approveArtifactInTransaction(
  db: Database,
  orderId: string,
  artifactId: number,
  worker: string,
  reason: string | undefined,
  at: string,
): void {
  appendOrderEventInTransaction(db, orderId, { kind: "artifact_approved", worker, artifactId, reason }, at);
  setOrderHoldInTransaction(db, orderId, null, at);
  appendOrderEventInTransaction(db, orderId, { kind: "hold_released", worker, evidence: { hold: null } }, at);
}

export function assertBuildReady(db: Database, orderId: string): { sha: string } {
  const commit = latestOrderCommit(db, orderId);
  if (!commit) throw new OrderNotDone("build_not_approved", `order ${orderId} has no build commit to review`);
  return { sha: commit.sha };
}

function returnable(db: Database, orderId: string, station: ArtifactKind): StoredArtifact {
  const artifact = latestArtifact(db, orderId, station);
  if (!artifact) throw new Error(`order ${orderId} has no ${station} artifact to return`);
  if (isArtifactApproved(db, artifact.id))
    throw new Error(`order ${orderId} has an approved ${station} artifact`);
  if (station === "review") {
    const round = db
      .query<{ outcome: string | null; findings: number }, [number]>(
        `SELECT r.outcome, (SELECT count(*) FROM factory_order_finding f WHERE f.review_id = r.id) AS findings
         FROM factory_order_review r WHERE r.id = ?`,
      )
      .get(artifact.reviewId as number);
    if (round?.outcome !== "closed" || round.findings !== 0) {
      throw new Error(`review ${artifact.reviewId} is not a clean Review artifact`);
    }
  }
  return artifact;
}

export function returnOrderArtifact(
  db: Database,
  orderId: string,
  operator: string,
  reason: string,
  at = now(),
): void {
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(operator)?.role;
  if (role !== "operator") throw new Error(`worker ${operator} is not an operator`);
  if (reason.trim() === "") throw new Error("artifact return reason must not be empty");
  db.transaction(() => {
    const order = db
      .query<{ status: OrderStatus; station: string | null; hold: string | null }, [string]>(
        "SELECT status, station, hold FROM factory_order WHERE id = ?",
      )
      .get(orderId);
    if ((order?.status !== "working" && order?.status !== "queued") || order.hold !== APPROVAL_HOLD) {
      throw new Error(`order ${orderId} has no station artifact awaiting owner approval`);
    }
    const station = order.station?.replace("dim-station-", "");
    if (station !== "plan" && station !== "build" && station !== "review") {
      throw new Error(`order ${orderId} is at ${order.station ?? "no station"}, which has no artifact gate`);
    }
    const artifact = returnable(db, orderId, station);
    appendOrderEventInTransaction(
      db,
      orderId,
      {
        kind: "artifact_returned",
        worker: operator,
        station: order.station ?? undefined,
        status: order.status === "queued" ? "working" : undefined,
        artifactId: artifact.id,
        reason,
      },
      at,
      process.cwd(),
      true,
    );
    setOrderHoldInTransaction(db, orderId, null, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "hold_released", worker: operator, evidence: { hold: null } },
      at,
    );
  })();
}

export type ReturnedOrderArtifact =
  | { station: "plan"; reason: string; artifactId: number; body: string }
  | { station: "build"; reason: string; artifactId: number; body: string; headSha: string }
  | {
      station: "review";
      reason: string;
      artifactId: number;
      reviewId: number;
      body: string;
      baseSha: string;
      headSha: string;
    };

export function returnedOrderArtifact(
  db: Database,
  orderId: string,
  station: "plan",
): Extract<ReturnedOrderArtifact, { station: "plan" }> | null;

export function returnedOrderArtifact(
  db: Database,
  orderId: string,
  station: "build",
): Extract<ReturnedOrderArtifact, { station: "build" }> | null;

export function returnedOrderArtifact(
  db: Database,
  orderId: string,
  station: "review",
): Extract<ReturnedOrderArtifact, { station: "review" }> | null;

export function returnedOrderArtifact(
  db: Database,
  orderId: string,
  station: ArtifactKind,
): ReturnedOrderArtifact | null;

export function returnedOrderArtifact(
  db: Database,
  orderId: string,
  station: ArtifactKind,
): ReturnedOrderArtifact | null {
  const returned = db
    .query<
      {
        reason: string;
        artifactId: number;
        body: string;
        headSha: string | null;
        reviewId: number | null;
        baseSha: string | null;
      },
      [string, ArtifactKind]
    >(
      `SELECT e.reason, a.id AS artifactId, a.body, a.head_sha AS headSha, a.review_id AS reviewId,
              r.base_sha AS baseSha
       FROM factory_order_event e
       JOIN factory_order_artifact a ON a.id = e.artifact_id
       LEFT JOIN factory_order_review r ON r.id = a.review_id
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
  if (!returned) return null;
  const { reason, artifactId, body } = returned;
  if (station === "plan") return { station, reason, artifactId, body };
  if (station === "build") return { station, reason, artifactId, body, headSha: returned.headSha as string };
  return {
    station,
    reason,
    artifactId,
    body,
    reviewId: returned.reviewId as number,
    baseSha: returned.baseSha as string,
    headSha: returned.headSha as string,
  };
}

export function assertReturnedArtifactRevised(db: Database, orderId: string, station: ArtifactKind): void {
  if (returnedOrderArtifact(db, orderId, station)) {
    throw new OrderNotDone(
      "artifact_revision_required",
      `order ${orderId} must receive a new ${station} artifact after its return before approval`,
    );
  }
}

export function assertOrderPlanning(db: Database, orderId: string): void {
  assertOrderWorking(db, orderId);
  const order = db.query("SELECT station FROM factory_order WHERE id = ?").get(orderId) as {
    station: string | null;
  } | null;
  if (order?.station !== "plan" && order?.station !== "dim-station-plan") {
    throw new OrderNotDone(
      "order_not_planning",
      `order ${orderId} must be at plan before a plan can be submitted`,
    );
  }
}

export function recordOrderPlan(
  db: Database,
  orderId: string,
  body: string,
  worker: string,
  slices: readonly PlanSlice[],
  at = now(),
): number {
  assertOrderPlanning(db, orderId);
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
    holdForApprovalInTransaction(db, orderId, worker, at);
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
  assertOrderWorking(db, orderId);
  const order = db
    .query<{ station: string | null; run_id: string | null }, [string]>(
      "SELECT station, run_id FROM factory_order WHERE id = ?",
    )
    .get(orderId);
  if (order?.station !== "build" && order?.station !== "dim-station-build") {
    throw new OrderNotDone(
      "order_not_building",
      `order ${orderId} must be at build before a build artifact can be submitted`,
    );
  }
  const returned = returnedOrderArtifact(db, orderId, "build");
  if ((order?.run_id === null || order?.run_id === undefined) && !returned) {
    throw new OrderNotDone(
      "build_artifact_before_final_slice",
      `order ${orderId} has no active final build turn or returned Build artifact`,
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
  if (returned && headSha !== returned.headSha) {
    const latestCommit = latestOrderCommit(db, orderId);
    if (latestCommit?.sha !== headSha) {
      throw new OrderNotDone(
        "build_revision_head_mismatch",
        `order ${orderId} must use the returned Build artifact's commit or its latest recorded commit`,
      );
    }
    assertChecked(db, orderId);
  }
  return db.transaction(() => {
    const artifactId = writeArtifactInTransaction(
      db,
      orderId,
      { kind: "build", body, headSha, reviewId: null },
      worker,
      at,
    );
    holdForApprovalInTransaction(db, orderId, worker, at);
    return artifactId;
  })();
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
    assertOrderWorking(db, orderId);
    const order = db
      .query<{ run_id: string | null; station: string | null }, [string]>(
        "SELECT run_id, station FROM factory_order WHERE id = ?",
      )
      .get(orderId);
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
    recordAttemptFinish(
      db,
      orderId,
      order?.run_id ?? null,
      worker,
      order?.station ?? null,
      "succeeded",
      undefined,
      at,
    );
    db.run("UPDATE factory_order SET run_id = NULL, session_id = NULL, updated_at = ? WHERE id = ?", [
      at,
      orderId,
    ]);
  })();
}

export function completeOrderBuildFollowup(db: Database, orderId: string, worker: string, at = now()): void {
  db.transaction(() => {
    assertOrderBuilding(db, orderId);
    if (nextOrderSlice(db, orderId) !== null) {
      throw new Error(`order ${orderId} still has an incomplete build slice`);
    }
    assertChecked(db, orderId);
    const commit = latestOrderCommit(db, orderId);
    const review = db
      .query<{ event_id: number }, [string]>(
        `SELECT e.id AS event_id FROM factory_order_review r
         JOIN factory_order_event e ON e.review_id = r.id AND e.kind = 'review_closed'
         WHERE r.order_id = ? ORDER BY r.round DESC LIMIT 1`,
      )
      .get(orderId);
    const artifact = commit
      ? db
          .query(
            `SELECT 1 FROM factory_order_artifact b
             JOIN factory_order_event e ON e.artifact_id = b.id AND e.kind = 'artifact_written'
             WHERE b.order_id = ? AND b.kind = 'build' AND b.head_sha = ? AND e.id > ?`,
          )
          .get(orderId, commit.sha, review?.event_id ?? Number.MAX_SAFE_INTEGER)
      : null;
    if (!artifact) throw new Error(`order ${orderId} has no Build artifact after its latest Review`);
    const order = db
      .query<{ run_id: string | null; station: string | null }, [string]>(
        "SELECT run_id, station FROM factory_order WHERE id = ?",
      )
      .get(orderId);
    if (!order?.run_id) throw new Error(`order ${orderId} has no active build follow-up`);
    recordAttemptFinish(db, orderId, order.run_id, worker, order.station, "succeeded", undefined, at);
    db.run("UPDATE factory_order SET run_id = NULL, session_id = NULL, updated_at = ? WHERE id = ?", [
      at,
      orderId,
    ]);
  })();
}

export function approveOrderPlan(db: Database, orderId: string, worker: string, at = now()): void {
  assertOrderWorking(db, orderId);
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(worker)?.role;
  if (role !== "operator")
    throw new PlanApprovalRefused("worker_not_operator", `worker ${worker} is not an operator`);
  assertReturnedArtifactRevised(db, orderId, "plan");
  const plan = latestArtifact(db, orderId, "plan");
  if (!plan) throw new PlanApprovalRefused("plan_missing", `order ${orderId} has no plan to approve`);
  if (isArtifactApproved(db, plan.id))
    throw new PlanApprovalRefused(
      "plan_already_approved",
      `plan ${plan.id} for order ${orderId} is already approved`,
    );
  db.transaction(() => approveArtifactInTransaction(db, orderId, plan.id, worker, undefined, at))();
}

export function approveOrderBuild(
  db: Database,
  orderId: string,
  worker: string,
  reason: string,
  at = now(),
): void {
  assertOrderWorking(db, orderId);
  const role = db
    .query<{ role: string }, [string]>("SELECT role FROM factory_worker WHERE name = ?")
    .get(worker)?.role;
  if (role !== "operator")
    throw new BuildApprovalRefused("worker_not_operator", `worker ${worker} is not an operator`);
  if (reason.trim() === "") throw new Error("build approval reason must not be empty");
  assertReturnedArtifactRevised(db, orderId, "build");
  const commit = latestOrderCommit(db, orderId);
  if (!commit)
    throw new BuildApprovalRefused("commit_missing", `order ${orderId} has no build commit to approve`);
  const check = db
    .query(
      `SELECT 1 FROM factory_order_check c
       JOIN factory_order_event check_event
         ON check_event.order_id = c.order_id AND check_event.check_id = c.id AND check_event.kind = 'check_finished'
       WHERE c.order_id = ? AND c.exit_code = 0
         AND check_event.id > coalesce((
           SELECT max(commit_event.id) FROM factory_order_event commit_event
           WHERE commit_event.order_id = c.order_id AND commit_event.kind = 'commit_created'
         ), 0)
       LIMIT 1`,
    )
    .get(orderId);
  if (!check) {
    throw new BuildApprovalRefused(
      "build_not_checked",
      `order ${orderId} has no passing check after its latest build commit`,
    );
  }
  if (nextOrderSlice(db, orderId) !== null) {
    throw new BuildApprovalRefused(
      "build_not_final",
      `order ${orderId} has incomplete slices; build approval belongs after the final slice`,
    );
  }
  const buildArtifact = db
    .query<{ id: number }, [string, string]>(
      `SELECT id FROM factory_order_artifact
       WHERE order_id = ? AND kind = 'build' AND head_sha = ? ORDER BY revision DESC LIMIT 1`,
    )
    .get(orderId, commit.sha);
  if (!buildArtifact) {
    throw new BuildApprovalRefused(
      "build_artifact_missing",
      `build ${commit.sha} for order ${orderId} has no artifact recorded by its builder`,
    );
  }
  const approved = db
    .query(
      `SELECT 1 FROM factory_order_event e
       JOIN factory_order_artifact a ON a.id = e.artifact_id
       WHERE e.kind = 'artifact_approved' AND a.order_id = ? AND a.kind = 'build' AND a.head_sha = ?`,
    )
    .get(orderId, commit.sha);
  if (approved) {
    throw new BuildApprovalRefused(
      "build_already_approved",
      `build ${commit.sha} for order ${orderId} is already approved`,
    );
  }
  db.transaction(() => approveArtifactInTransaction(db, orderId, buildArtifact.id, worker, reason, at))();
}
