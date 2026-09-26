import type { Database } from "bun:sqlite";
import { latestOrderCommit } from "./factory-order-commits";
import {
  appendOrderEventInTransaction,
  assertChecked,
  now,
  recordAttemptFinish,
  recordOwnerVerdictInTransaction,
  setOrderHoldInTransaction,
} from "./factory-order-ledger";
import {
  APPROVAL_HOLD,
  assertOrderBuilding,
  assertOrderWorking,
  BuildApprovalRefused,
  type OrderEvent,
  OrderNotDone,
  type OrderStatus,
  PlanApprovalRefused,
} from "./factory-order-status";
import type { PlanSlice } from "./plan-artifact";

export function assertBuildReady(db: Database, orderId: string): { sha: string } {
  const commit = latestOrderCommit(db, orderId);
  if (!commit) throw new OrderNotDone("build_not_approved", `order ${orderId} has no build commit to review`);
  return { sha: commit.sha };
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
    let returned: OrderEvent;
    if (station === "plan") {
      const artifact = db
        .query<{ id: number }, [string]>(
          "SELECT id FROM factory_order_plan WHERE order_id = ? ORDER BY revision DESC, id DESC LIMIT 1",
        )
        .get(orderId);
      if (!artifact) throw new Error(`order ${orderId} has no Plan artifact to return`);
      if (
        db
          .query(
            "SELECT 1 FROM factory_order_event WHERE order_id = ? AND kind = 'plan_approved' AND plan_id = ?",
          )
          .get(orderId, artifact.id)
      ) {
        throw new Error(`order ${orderId} has an approved Plan artifact`);
      }
      returned = {
        kind: "artifact_returned",
        worker: operator,
        station: order.station ?? undefined,
        status: order.status === "queued" ? "working" : undefined,
        planId: artifact.id,
        reason,
      };
    } else if (station === "build") {
      const artifact = db
        .query<{ id: number; head_sha: string }, [string]>(
          "SELECT id, head_sha FROM factory_order_build WHERE order_id = ? ORDER BY revision DESC, id DESC LIMIT 1",
        )
        .get(orderId);
      if (!artifact) throw new Error(`order ${orderId} has no Build artifact to return`);
      if (
        db
          .query(
            "SELECT 1 FROM factory_order_event WHERE order_id = ? AND kind = 'build_approved' AND commit_sha = ?",
          )
          .get(orderId, artifact.head_sha)
      ) {
        throw new Error(`order ${orderId} has an approved Build artifact`);
      }
      returned = {
        kind: "artifact_returned",
        worker: operator,
        station: order.station ?? undefined,
        status: order.status === "queued" ? "working" : undefined,
        buildId: artifact.id,
        commitSha: artifact.head_sha,
        reason,
      };
    } else if (station === "review") {
      const artifact = db
        .query<{ review_id: number; outcome: string | null; findings: number }, [string]>(
          `SELECT a.review_id, r.outcome,
                  (SELECT count(*) FROM factory_order_finding f WHERE f.review_id = r.id) AS findings
           FROM factory_order_review_artifact a
           JOIN factory_order_review r ON r.id = a.review_id
           WHERE a.order_id = ? ORDER BY a.id DESC LIMIT 1`,
        )
        .get(orderId);
      if (!artifact) throw new Error(`order ${orderId} has no Review artifact to return`);
      if (artifact.outcome !== "closed" || artifact.findings !== 0) {
        throw new Error(`review ${artifact.review_id} is not a clean Review artifact`);
      }
      if (
        db
          .query(
            "SELECT 1 FROM factory_order_event WHERE order_id = ? AND kind = 'review_approved' AND review_id = ?",
          )
          .get(orderId, artifact.review_id)
      ) {
        throw new Error(`order ${orderId} has an approved Review artifact`);
      }
      returned = {
        kind: "artifact_returned",
        worker: operator,
        station: order.station ?? undefined,
        status: order.status === "queued" ? "working" : undefined,
        reviewId: artifact.review_id,
        reason,
      };
    } else {
      throw new Error(`order ${orderId} is at ${order.station ?? "no station"}, which has no artifact gate`);
    }
    appendOrderEventInTransaction(db, orderId, returned, at, process.cwd(), true);
    recordOwnerVerdictInTransaction(db, orderId, "returned", reason, operator, at);
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
  | { station: "plan"; reason: string; planId: number; body: string }
  | { station: "build"; reason: string; buildId: number; body: string; headSha: string }
  | {
      station: "review";
      reason: string;
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
  station: "plan" | "build" | "review",
): ReturnedOrderArtifact | null;

export function returnedOrderArtifact(
  db: Database,
  orderId: string,
  station: "plan" | "build" | "review",
): ReturnedOrderArtifact | null {
  const artifactEvent = {
    plan: "plan_artifact_written",
    build: "build_artifact_written",
    review: "review_artifact_written",
  }[station];
  const event = db
    .query<
      { reason: string; plan_id: number | null; build_id: number | null; review_id: number | null },
      [string, string, string, string]
    >(
      `SELECT returned.reason, returned.plan_id, returned.build_id, returned.review_id
       FROM factory_order_event returned
       WHERE returned.order_id = ? AND returned.kind = 'artifact_returned'
         AND returned.station IN (?, ?)
         AND NOT EXISTS (
           SELECT 1 FROM factory_order_event written
           WHERE written.order_id = returned.order_id AND written.kind = ?
             AND written.id > returned.id
         )
       ORDER BY returned.id DESC LIMIT 1`,
    )
    .get(orderId, station, `dim-station-${station}`, artifactEvent);
  if (!event) return null;
  if (station === "plan" && event.plan_id !== null) {
    const artifact = db
      .query<{ body: string }, [number]>("SELECT body FROM factory_order_plan WHERE id = ?")
      .get(event.plan_id);
    if (!artifact) throw new Error(`Plan artifact ${event.plan_id} is missing`);
    return { station, reason: event.reason, planId: event.plan_id, body: artifact.body };
  }
  if (station === "build" && event.build_id !== null) {
    const artifact = db
      .query<{ body: string; head_sha: string }, [number]>(
        "SELECT body, head_sha FROM factory_order_build WHERE id = ?",
      )
      .get(event.build_id);
    if (!artifact) throw new Error(`Build artifact ${event.build_id} is missing`);
    return {
      station,
      reason: event.reason,
      buildId: event.build_id,
      body: artifact.body,
      headSha: artifact.head_sha,
    };
  }
  if (station === "review" && event.review_id !== null) {
    const artifact = db
      .query<{ body: string; base_sha: string; head_sha: string }, [number]>(
        `SELECT a.body, r.base_sha, r.head_sha
         FROM factory_order_review_artifact a
         JOIN factory_order_review r ON r.id = a.review_id
         WHERE a.review_id = ? ORDER BY a.revision DESC LIMIT 1`,
      )
      .get(event.review_id);
    if (!artifact) throw new Error(`Review artifact ${event.review_id} is missing`);
    return {
      station,
      reason: event.reason,
      reviewId: event.review_id,
      body: artifact.body,
      baseSha: artifact.base_sha,
      headSha: artifact.head_sha,
    };
  }
  throw new Error(`order ${orderId} has an incomplete ${station} artifact return`);
}

export function assertReturnedArtifactRevised(
  db: Database,
  orderId: string,
  station: "plan" | "build" | "review",
): void {
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
    const revision = (db
      .query<{ revision: number }, [string]>(
        "SELECT coalesce(max(revision), 0) + 1 AS revision FROM factory_order_plan WHERE order_id = ?",
      )
      .get(orderId)?.revision ?? 1) as number;
    const written = db.run(
      "INSERT INTO factory_order_plan (order_id, revision, worker, body, recorded_at) VALUES (?, ?, ?, ?, ?)",
      [orderId, revision, worker, body, at],
    );
    const planId = Number(written.lastInsertRowid);
    for (const [index, slice] of slices.entries()) {
      db.run("INSERT INTO factory_order_slice (plan_id, ordinal, title, outcome) VALUES (?, ?, ?, ?)", [
        planId,
        index + 1,
        slice.title,
        slice.outcome,
      ]);
    }
    appendOrderEventInTransaction(db, orderId, { kind: "plan_artifact_written", worker, planId }, at);
    setOrderHoldInTransaction(db, orderId, APPROVAL_HOLD, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "hold_set", worker, holdType: APPROVAL_HOLD, evidence: { hold: APPROVAL_HOLD } },
      at,
    );
    return planId;
  })();
}

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
  if ((order?.run_id === null || order?.run_id === undefined) && !returned?.buildId) {
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
         JOIN factory_order_plan p ON p.id = s.plan_id
         WHERE p.order_id = ? AND EXISTS (
           SELECT 1 FROM factory_order_event e
           WHERE e.order_id = p.order_id AND e.kind = 'plan_approved' AND e.plan_id = p.id
         )`,
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
    const revision = (db
      .query<{ revision: number }, [string]>(
        "SELECT coalesce(max(revision), 0) + 1 AS revision FROM factory_order_build WHERE order_id = ?",
      )
      .get(orderId)?.revision ?? 1) as number;
    const written = db.run(
      `INSERT INTO factory_order_build (order_id, revision, worker, body, head_sha, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, revision, worker, body, headSha, at],
    );
    const buildId = Number(written.lastInsertRowid);
    appendOrderEventInTransaction(db, orderId, { kind: "build_artifact_written", worker, buildId }, at);
    setOrderHoldInTransaction(db, orderId, APPROVAL_HOLD, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "hold_set", worker, holdType: APPROVAL_HOLD, evidence: { hold: APPROVAL_HOLD } },
      at,
    );
    return buildId;
  })();
}

export type OrderSlice = PlanSlice & { id: number; ordinal: number };

export function nextOrderSlice(db: Database, orderId: string): OrderSlice | null {
  return db
    .query<OrderSlice, [string]>(
      `SELECT s.id, s.ordinal, s.title, s.outcome
       FROM factory_order_slice s
       JOIN factory_order_plan p ON p.id = s.plan_id
       WHERE p.order_id = ? AND EXISTS (
         SELECT 1 FROM factory_order_event e
         WHERE e.order_id = p.order_id AND e.kind = 'plan_approved' AND e.plan_id = p.id
       ) AND NOT EXISTS (
         SELECT 1 FROM factory_order_slice_completion c WHERE c.slice_id = s.id
       )
       ORDER BY p.revision DESC, p.id DESC, s.ordinal
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
         JOIN factory_order_plan p ON p.id = s.plan_id
         WHERE p.order_id = ? AND s.id = ? AND EXISTS (
           SELECT 1 FROM factory_order_event e
           WHERE e.order_id = p.order_id AND e.kind = 'plan_approved' AND e.plan_id = p.id
         )`,
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
            `SELECT 1 FROM factory_order_build b
             JOIN factory_order_event e ON e.build_id = b.id AND e.kind = 'build_artifact_written'
             WHERE b.order_id = ? AND b.head_sha = ? AND e.id > ?`,
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
  const plan = db
    .query<{ id: number }, [string]>(
      "SELECT id FROM factory_order_plan WHERE order_id = ? ORDER BY revision DESC, id DESC LIMIT 1",
    )
    .get(orderId);
  if (!plan) throw new PlanApprovalRefused("plan_missing", `order ${orderId} has no plan to approve`);
  const approved = db
    .query("SELECT id FROM factory_order_event WHERE order_id = ? AND kind = 'plan_approved' AND plan_id = ?")
    .get(orderId, plan.id);
  if (approved)
    throw new PlanApprovalRefused(
      "plan_already_approved",
      `plan ${plan.id} for order ${orderId} is already approved`,
    );
  db.transaction(() => {
    recordOwnerVerdictInTransaction(db, orderId, "approved", "plan approved", worker, at);
    appendOrderEventInTransaction(db, orderId, { kind: "plan_approved", worker, planId: plan.id }, at);
    setOrderHoldInTransaction(db, orderId, null, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "hold_released", worker, evidence: { hold: null } },
      at,
    );
  })();
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
      "SELECT id FROM factory_order_build WHERE order_id = ? AND head_sha = ? ORDER BY revision DESC LIMIT 1",
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
      "SELECT id FROM factory_order_event WHERE order_id = ? AND kind = 'build_approved' AND commit_sha = ?",
    )
    .get(orderId, commit.sha);
  if (approved) {
    throw new BuildApprovalRefused(
      "build_already_approved",
      `build ${commit.sha} for order ${orderId} is already approved`,
    );
  }
  db.transaction(() => {
    recordOwnerVerdictInTransaction(db, orderId, "approved", reason, worker, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "build_approved", worker, commitSha: commit.sha, reason },
      at,
    );
    setOrderHoldInTransaction(db, orderId, null, at);
    appendOrderEventInTransaction(
      db,
      orderId,
      { kind: "hold_released", worker, evidence: { hold: null } },
      at,
    );
  })();
}
