import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CHECK_SANDBOX, runSandboxedCheck } from "./check-sandbox";
import { withLock } from "./db-lock";
import { assertOperator } from "./factory-operator";
import { currentOrderCommits, latestOrderCommit } from "./order-commits";
import type { EvidenceReference } from "./order-events";
import { type OrderCheck, recordOrderCheck, recordOrderRewrite } from "./order-evidence";
import { appendOrderEventInTransaction, now } from "./order-ledger";
import { assertNext } from "./order-state";
import { dataDir, type Env } from "./paths";
import { type RebaseVerdict, type ShipOutcome, shipBranch } from "./ship";
import { RebaseConflict, type Rewrite } from "./ship-rebase";
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

export function shipOrder(
  db: Database,
  orderId: string,
  worktree: string,
  worker: string,
  options: { env?: Env; checkSandbox?: string[] } = {},
): ShipOutcome {
  const env = options.env ?? process.env;
  assertOperator(db, worker, "ship an order");
  assertNext(db, orderId, "ship");
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
    recordOrderRewrite(db, orderId, rewrite, check, worker);
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
