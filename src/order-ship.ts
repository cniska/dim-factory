import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CHECK_SANDBOX, runSandboxedCheck } from "./check-sandbox";
import { withLock } from "./db-lock";
import { assertOperator } from "./factory-operator";
import { currentOrderCommits, latestOrderCommit } from "./order-commits";
import type { EvidenceReference } from "./order-events";
import { type OrderCheck, recordOrderRewrite } from "./order-evidence";
import { appendOrderEvent } from "./order-ledger";
import { assertNext } from "./order-state";
import { dataDir, type Env } from "./paths";
import { type RebaseVerdict, type ShipOutcome, shipBranch } from "./ship";
import { RebaseConflict, type Rewrite } from "./ship-rebase";
import { ShipRefusal } from "./ship-refusal";
import { checkTask } from "./workspace-tasks";
import { removeWorktree } from "./wt-command";

function refusalEvidence(error: unknown): EvidenceReference {
  if (error instanceof RebaseConflict) {
    return {
      code: error.code,
      paths: JSON.stringify(error.paths),
      oldBase: error.replay.oldBase,
      newBase: error.replay.newBase,
      oldHead: error.replay.oldHead,
      stoppedAt: error.stoppedAt,
    };
  }
  return error instanceof ShipRefusal ? { code: error.code } : {};
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
  cwd: string,
  worker: string,
  options: { env?: Env; checkSandbox?: string[] } = {},
): ShipOutcome {
  const env = options.env ?? process.env;
  return withLock(() => {
    assertOperator(db, worker, "ship an order");
    assertNext(db, orderId, "ship");
    const shas = currentOrderCommits(db, orderId).map((row) => row.sha);
    const onRebased = (rewrite: Rewrite): RebaseVerdict => {
      const check = recheck(rewrite.worktree, env, options.checkSandbox ?? CHECK_SANDBOX);
      recordOrderRewrite(db, orderId, rewrite, check, worker);
      if (check.exitCode !== 0) {
        return {
          hold: new ShipRefusal(
            "ship_check_failed",
            `${check.command} exited ${check.exitCode} at the rebased head ${rewrite.newHead}; the rebase is kept and the order is back at build:\n${check.result}`,
          ),
        };
      }
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
      outcome = shipBranch(cwd, orderId, shas, onRebased);
    } catch (error) {
      appendOrderEvent(db, orderId, {
        kind: "ship_failed",
        worker,
        commitSha: latestOrderCommit(db, orderId)?.sha,
        reason: error instanceof Error ? error.message : String(error),
        evidence: refusalEvidence(error),
      });
      throw error;
    }
    removeWorktree(orderId, { cwd });
    appendOrderEvent(db, orderId, {
      kind: "shipped",
      worker,
      commitSha: latestOrderCommit(db, orderId)?.sha,
      evidence: { landed: outcome.landed },
    });
    return outcome;
  }, env);
}
