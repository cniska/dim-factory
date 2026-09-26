import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { latestApprovedPlan } from "./approved-plan";
import type { EvidenceReference } from "./factory-events";
import { assertOperator } from "./factory-operator";
import { isArtifactApproved, latestArtifact, nextOrderSlice } from "./factory-order-artifacts";
import {
  carriedThroughRewrites,
  currentOrderCommits,
  latestOrderCommit,
  pendingRebaseConflict,
} from "./factory-order-commits";
import { type OrderCheck, recordOrderCheck, recordOrderRewrite } from "./factory-order-evidence";
import { appendOrderEventInTransaction, now } from "./factory-order-ledger";
import { moveOrder } from "./factory-order-lifecycle";
import { assertReviewApproved } from "./factory-order-review";
import { assertOrderWorking, OrderNotDone } from "./factory-order-status";
import { withLock } from "./lock";
import { dataDir, type Env } from "./paths";
import { RebaseConflict, type Rewrite } from "./rebase-onto-trunk";
import { CHECK_SANDBOX, runSandboxedCheck } from "./sandboxed-check";
import { type RebaseVerdict, type ShipOutcome, shipBranch } from "./ship";
import { ShipRefusal } from "./ship-refusal";
import { checkTask } from "./workspace-tasks";

function recordDeliveryInTransaction(
  db: Database,
  orderId: string,
  kind: "integration" | "delivery",
  outcome: "succeeded" | "failed",
  target: string,
  commitSha: string | null,
  worker: string,
  at: string,
  reason?: string,
  evidence: EvidenceReference = {},
): number {
  const sessionId = db
    .query<{ session_id: string | null }, [string]>("SELECT session_id FROM factory_worker WHERE name = ?")
    .get(worker)?.session_id;
  const written = db.run(
    `INSERT INTO factory_order_delivery
       (order_id, kind, outcome, target, commit_sha, worker, session_id, recorded_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orderId, kind, outcome, target, commitSha, worker, sessionId ?? null, at, reason ?? null],
  );
  appendOrderEventInTransaction(
    db,
    orderId,
    {
      kind: kind === "integration" ? "integration_recorded" : "delivery_recorded",
      worker,
      commitSha: commitSha ?? undefined,
      reason,
      evidence: { ...evidence, deliveryId: Number(written.lastInsertRowid), outcome },
    },
    at,
  );
  return Number(written.lastInsertRowid);
}

export function recheck(worktree: string, env: Env, sandbox: string[]): OrderCheck {
  const declared = checkTask(worktree);
  if (!declared) {
    throw new ShipRefusal(
      "ship_check_failed",
      `${worktree} declares no check, so the rebased branch cannot be verified`,
    );
  }
  const check = runSandboxedCheck({
    worktree,
    command: declared.commandLine,
    canary: join(dataDir(env), `check-canary-${randomUUID()}`),
    sandbox,
    env: env.PATH === undefined ? {} : { PATH: env.PATH },
  });
  return {
    command: check.command,
    exitCode: check.exitCode,
    startedAt: check.startedAt,
    finishedAt: check.finishedAt,
    result: check.output,
  };
}

function assertShippable(db: Database, orderId: string): void {
  if (!latestApprovedPlan(db, orderId)) {
    throw new OrderNotDone(
      "plan_not_approved",
      `order ${orderId} has no approved plan, so nothing of it can ship`,
    );
  }
  if (nextOrderSlice(db, orderId)) {
    throw new OrderNotDone("build_not_final", `order ${orderId} has slices its builder has not finished`);
  }
  const build = latestArtifact(db, orderId, "build");
  const head = latestOrderCommit(db, orderId)?.sha;
  if (
    !build ||
    !isArtifactApproved(db, build.id) ||
    carriedThroughRewrites(db, orderId, build.headSha as string) !== head
  ) {
    throw new OrderNotDone(
      "build_not_approved",
      `order ${orderId} has no approved Build artifact for the commit it would ship`,
    );
  }
  assertReviewApproved(db, orderId);
}

export function shipOrder(
  db: Database,
  orderId: string,
  worktree: string,
  worker: string,
  options: { env?: Env; checkSandbox?: string[] } = {},
): ShipOutcome {
  const env = options.env ?? process.env;
  assertOperator(db, worker, "ship an order");
  assertOrderWorking(db, orderId);
  assertShippable(db, orderId);
  const conflict = pendingRebaseConflict(db, orderId);
  if (conflict) {
    throw new ShipRefusal(
      "ship_rebase_conflict",
      `order ${orderId} has a rebase conflict in ${conflict.paths.join(", ")} its builder has not resolved; it ships once build has`,
    );
  }
  const shas = currentOrderCommits(db, orderId).map((row) => row.sha);
  const onRebased = (rewrite: Rewrite): RebaseVerdict => {
    const check = recheck(rewrite.worktree, env, options.checkSandbox ?? CHECK_SANDBOX);
    if (check.exitCode !== 0) {
      recordOrderCheck(db, orderId, check, worker);
      throw new ShipRefusal(
        "ship_check_failed",
        `${check.command} exited ${check.exitCode} at the rebased head ${rewrite.newHead}; the rebase was taken back:\n${check.result}`,
      );
    }
    db.transaction(() => {
      recordOrderRewrite(db, orderId, rewrite, check, worker);
      if (!rewrite.patchEqual) moveOrder(db, orderId, "review", worker);
    })();
    if (rewrite.patchEqual) return { land: currentOrderCommits(db, orderId).map((row) => row.sha) };
    return {
      hold: new ShipRefusal(
        "ship_patch_changed",
        `rebasing ${orderId} onto the trunk changed a patch, so its approved review no longer covers it; it is back at review`,
      ),
    };
  };
  let outcome: ShipOutcome;
  try {
    outcome = withLock(() => shipBranch(worktree, orderId, shas, onRebased), env);
  } catch (error) {
    const at = now();
    const reason = error instanceof Error ? error.message : String(error);
    db.transaction(() => {
      recordDeliveryInTransaction(
        db,
        orderId,
        "delivery",
        "failed",
        orderId,
        latestOrderCommit(db, orderId)?.sha ?? null,
        worker,
        at,
        reason,
        error instanceof RebaseConflict
          ? {
              code: error.code,
              paths: JSON.stringify(error.paths),
              oldBase: error.replay.oldBase,
              newBase: error.replay.newBase,
              oldHead: error.replay.oldHead,
              stoppedAt: error.stoppedAt,
            }
          : {},
      );
      if (error instanceof RebaseConflict) moveOrder(db, orderId, "build", worker, at);
    })();
    throw error;
  }
  const landed = latestOrderCommit(db, orderId)?.sha ?? null;
  const at = now();
  db.transaction(() => {
    recordDeliveryInTransaction(db, orderId, "integration", "succeeded", orderId, landed, worker, at);
    recordDeliveryInTransaction(db, orderId, "delivery", "succeeded", orderId, landed, worker, at);
  })();
  return outcome;
}
