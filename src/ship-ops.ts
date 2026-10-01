import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { judge } from "./check-ops";
import type { UserConfig } from "./config";
import { checkTask } from "./declared-tasks";
import { isClean, moveRef, tipOf } from "./git-tree";
import type { Evidence } from "./order-contract";
import { orderState, recordFactory } from "./order-ops";
import type { Env } from "./paths";
import { refuseShip } from "./ship-contract";
import {
  checkedOutBranch,
  commitsSince,
  fastForward,
  mergeTree,
  parentOf,
  recommit,
  shipLock,
} from "./ship-effects";
import { branchOf } from "./workspace";
import { removeWorkspace, resetWorkspace, spreadMerge, workspaceOf } from "./workspace-ops";

export type ShipOf = {
  readonly order: string;
  readonly project: string;
  readonly checkout: string;
  readonly defaultBranch: string;
  readonly config: UserConfig;
  readonly cause: number;
  readonly env: Env;
};

type Replayed = {
  readonly head: string;
  readonly moved: readonly { readonly from: string; readonly to: string }[];
  readonly conflict: {
    readonly commit: string;
    readonly tree: string;
    readonly paths: readonly string[];
  } | null;
};

function replay(root: string, onto: string, commits: readonly string[], oldHead: string): Replayed {
  const [first] = commits;
  if (first === undefined || parentOf(root, first) === onto)
    return { head: oldHead, moved: [], conflict: null };
  let head = onto;
  const moved: { from: string; to: string }[] = [];
  for (const commit of commits) {
    const base = parentOf(root, commit);
    const merged = mergeTree(root, base, head, commit);
    if (merged.kind === "conflict") {
      const rest = mergeTree(root, base, head, oldHead);
      return { head, moved, conflict: { commit, tree: rest.tree, paths: merged.paths } };
    }
    const to = recommit(root, commit, merged.tree, head);
    moved.push({ from: commit, to });
    head = to;
  }
  return { head, moved, conflict: null };
}

export async function shipOrder(db: Database, ship: ShipOf): Promise<void> {
  const release = await shipLock(ship.project);
  try {
    land(db, ship);
  } finally {
    release();
  }
}

function land(db: Database, ship: ShipOf): void {
  const { order, checkout, defaultBranch, cause } = ship;
  const record = (later: Parameters<typeof recordFactory>[3]) => recordFactory(db, order, cause, later);
  record({ action: "ship_started", details: {} });
  if (ship.config.ship === undefined) {
    record({ action: "ship_stopped", code: "ship_unset", details: {} });
    throw refuseShip("ship_unset", { order, project: ship.project });
  }
  if (!isClean(checkout, "no")) {
    record({ action: "ship_stopped", code: "checkout_dirty", details: { checkout } });
    throw refuseShip("checkout_dirty", { order, checkout });
  }
  const { head } = orderState(db, order);
  invariant(head !== null, `order ${order} has a recorded head when it ships`);
  const branch = branchOf(order);
  const workspace = workspaceOf(ship.project, order);
  const onto = tipOf(checkout, defaultBranch);
  const replayed = replay(checkout, onto, commitsSince(checkout, defaultBranch, head), head);
  const rebase: Evidence = { kind: "rebase", onto, commits: [...replayed.moved] };
  if (replayed.head !== head) {
    record({ action: "branch_rebased", details: { head: replayed.head } });
    moveRef(checkout, branch, replayed.head, head);
    resetWorkspace(checkout, ship.project, order, replayed.head);
  }
  if (replayed.conflict !== null) {
    const { commit, tree, paths } = replayed.conflict;
    spreadMerge(ship.project, order, tree);
    record({ action: "ship_stopped", code: "ship_conflict", details: { commit, paths: [...paths] } });
    throw refuseShip("ship_conflict", { order, commit, paths });
  }
  const task = checkTask(workspace);
  const check = task === null ? null : judge(workspace, task.commandLine, ship.env);
  if (check === null || check.exitCode !== 0) {
    record({
      action: "ship_stopped",
      code: "ship_check_failed",
      details: { head: replayed.head },
      evidence: check === null ? [rebase] : [rebase, check],
    });
    throw check === null
      ? refuseShip("ship_no_check", { order, head: replayed.head })
      : refuseShip("ship_check_failed", {
          order,
          head: replayed.head,
          command: check.command,
          exitCode: check.exitCode,
        });
  }
  if (checkedOutBranch(checkout) === defaultBranch) fastForward(checkout, replayed.head);
  else moveRef(checkout, defaultBranch, replayed.head, onto);
  const kept = removeWorkspace(checkout, ship.project, order);
  record({
    action: "ship_landed",
    details: { head: replayed.head, kept: [...kept] },
    evidence: [rebase, check],
  });
  if (kept.length === 0) record({ action: "cleaned_up", details: {} });
}
