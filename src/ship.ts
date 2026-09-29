import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CHECK_SANDBOX, runSandboxedCheck, type SandboxedCheck } from "./check-sandbox";
import { CodedError } from "./coded-error";
import { withLock } from "./db-lock";
import type { Rewrite } from "./git-rebase-contract";
import { beginShip, recordShipCleanup, recordShipRun } from "./order";
import type { ShipRun } from "./order-contract";
import { dataDir, type Env } from "./paths";
import { type RebaseVerdict, shipBranch } from "./ship-branch";
import { removeShippedBranch } from "./ship-cleanup";
import { fail, type ShipCleanup, type ShipErrorMeta, type ShipOutcome } from "./ship-contract";
import { trunkCheck } from "./workspace-tasks";

type Conflict = CodedError<"ship_rebase_conflict", ShipErrorMeta<"ship_rebase_conflict">>;

const isConflict = (error: CodedError): error is Conflict => error.code === "ship_rebase_conflict";

function refusal(error: CodedError): Exclude<ShipRun, { outcome: "landed" }> {
  if (isConflict(error)) {
    const { replay, paths, stoppedAt } = error.meta;
    return { outcome: "conflict", replay, paths, stoppedAt };
  }
  return { outcome: "refused", code: error.code, reason: error.message };
}

export function recheck(worktree: string, env: Env, sandbox: string[]): SandboxedCheck {
  const governing = trunkCheck(worktree);
  if ("refused" in governing) {
    throw governing.refused === "undeclared"
      ? fail("ship_check_undeclared", { trunk: governing.trunk })
      : fail("ship_check_redefined", {
          task: governing.task.name,
          source: governing.task.source,
          trunk: governing.trunk,
        });
  }
  return runSandboxedCheck({
    worktree,
    command: governing.task.commandLine,
    canary: join(dataDir(env), `check-canary-${randomUUID()}`),
    sandbox,
    env: env.PATH === undefined ? {} : { PATH: env.PATH },
  });
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
    const shas = beginShip(db, orderId, worker, options.retry === true);
    let rebased: ShipRun["rebased"];
    const onRebased = (rewrite: Rewrite): RebaseVerdict => {
      const check = recheck(rewrite.worktree, env, options.checkSandbox ?? CHECK_SANDBOX);
      rebased = { rewrite, check };
      if (check.exitCode !== 0) {
        return {
          hold: fail("ship_check_failed", {
            command: check.command,
            exitCode: check.exitCode,
            head: rewrite.newHead,
          }),
        };
      }
      if (!rewrite.patchEqual) return { hold: fail("ship_patch_changed", { orderId }) };
      return {
        land: shas.map(
          (sha) => rewrite.commits.find(({ from }) => from.startsWith(sha.toLowerCase()))?.to ?? sha,
        ),
      };
    };
    let outcome: ShipOutcome;
    try {
      outcome = shipBranch(cwd, orderId, shas, onRebased);
    } catch (error) {
      if (error instanceof CodedError) recordShipRun(db, orderId, { rebased, ...refusal(error) });
      throw error;
    }
    const landed = recordShipRun(db, orderId, { rebased, outcome: "landed" });
    const cleanup = removeShippedBranch(orderId, cwd);
    recordShipCleanup(db, orderId, landed, cleanup);
    const { teardown: _, ...kept } = cleanup;
    return { ...outcome, ...kept };
  }, env);
}
