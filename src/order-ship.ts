import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CHECK_SANDBOX, runSandboxedCheck } from "./check-sandbox";
import { withLock } from "./db-lock";
import { assertOperator } from "./factory-operator";
import { currentOrderCommits } from "./order-commits";
import { type OrderCheck, recordOrderEnvironment } from "./order-evidence";
import { appendOrderEvent } from "./order-ledger";
import { recordShipRun, type ShipRun } from "./order-ship-run";
import { assertNext } from "./order-state";
import { dataDir, type Env } from "./paths";
import { type RebaseVerdict, type ShipOutcome, shipBranch } from "./ship";
import { removeShippedBranch, type ShipCleanup } from "./ship-cleanup";
import { RebaseConflict, type Rewrite } from "./ship-rebase";
import { ShipRefusal } from "./ship-refusal";
import { trunkCheck } from "./workspace-tasks";

function refusal(error: unknown): Exclude<ShipRun, { outcome: "landed" }> {
  if (error instanceof RebaseConflict) {
    const { oldBase, newBase, oldHead } = error.replay;
    return {
      outcome: "conflict",
      replay: { oldBase, newBase, oldHead },
      paths: error.paths,
      stoppedAt: error.stoppedAt,
    };
  }
  return {
    outcome: "refused",
    code: error instanceof ShipRefusal ? error.code : null,
    reason: error instanceof Error ? error.message : String(error),
  };
}

export function recheck(worktree: string, env: Env, sandbox: string[]): OrderCheck {
  const governing = trunkCheck(worktree);
  if ("refused" in governing) {
    throw governing.refused === "undeclared"
      ? new ShipRefusal(
          "ship_check_failed",
          `${governing.trunk} declares no check, so the rebased branch cannot be verified`,
        )
      : new ShipRefusal(
          "ship_check_redefined",
          `the rebased branch redefines ${governing.task.name} in ${governing.task.source}, the check ${governing.trunk} declares, so it is not verified by it`,
        );
  }
  const declared = governing.task;
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
  options: { env?: Env; checkSandbox?: string[]; retry?: boolean } = {},
): ShipOutcome & ShipCleanup {
  const env = options.env ?? process.env;
  return withLock(() => {
    assertOperator(db, worker, "ship an order");
    assertNext(db, orderId, "ship");
    if (options.retry) appendOrderEvent(db, orderId, { kind: "ship_retried", worker });
    const shas = currentOrderCommits(db, orderId).map((row) => row.sha);
    let rebased: ShipRun["rebased"];
    const onRebased = (rewrite: Rewrite): RebaseVerdict => {
      const check = recheck(rewrite.worktree, env, options.checkSandbox ?? CHECK_SANDBOX);
      rebased = { rewrite, check };
      if (check.exitCode !== 0) {
        return {
          hold: new ShipRefusal(
            "ship_check_failed",
            `${check.command} exited ${check.exitCode} at the rebased head ${rewrite.newHead}; the rebase is kept and the order is back at build:\n${check.result}`,
          ),
        };
      }
      if (rewrite.patchEqual) {
        return {
          land: shas.map(
            (sha) => rewrite.commits.find(({ from }) => from.startsWith(sha.toLowerCase()))?.to ?? sha,
          ),
        };
      }
      return {
        hold: new ShipRefusal(
          "ship_patch_changed",
          `rebasing ${orderId} onto the default branch changed a patch, so its approved review no longer covers it; it is back at review`,
        ),
      };
    };
    let outcome: ShipOutcome;
    try {
      outcome = shipBranch(cwd, orderId, shas, onRebased);
    } catch (error) {
      recordShipRun(db, orderId, { rebased, ...refusal(error) });
      throw error;
    }
    const { teardown, ...kept } = removeShippedBranch(orderId, cwd);
    if (teardown) recordOrderEnvironment(db, orderId, teardown);
    recordShipRun(db, orderId, { rebased, outcome: "landed", ...kept });
    return { ...outcome, ...kept };
  }, env);
}
