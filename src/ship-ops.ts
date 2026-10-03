import type { Database } from "bun:sqlite";
import { invariant } from "./assert";
import { judge } from "./check-ops";
import type { UserConfig } from "./config";
import { checkTask } from "./declared-tasks";
import { checkedOutBranch, commitsBetween, isClean, tipOf } from "./git";
import { movedCommits } from "./order";
import type { Later } from "./order-contract";
import { orderState, ownerIdentity, recordAs } from "./order-ops";
import type { Env } from "./paths";
import { refuseShip } from "./ship-contract";
import { fastForward, shipLock } from "./ship-effects";
import type { Trace } from "./trace-contract";
import type { Workspace } from "./workspace";
import { moveBranch, rebaseOnto, removeWorkspace, settleWorkspace, workspaceOf } from "./workspace-ops";

export type ShipOf = {
  readonly trace: Trace;
  readonly order: string;
  readonly project: string;
  readonly checkout: string;
  readonly defaultBranch: string;
  readonly config: UserConfig;
  readonly cause: number;
  readonly env: Env;
};

type Shipping = ShipOf & {
  readonly workspace: Workspace;
  readonly record: (later: Later) => void;
};

export async function shipOrder(db: Database, ship: ShipOf): Promise<void> {
  const release = await shipLock(ship.trace, ship.project, ship.env);
  try {
    land(db, ship);
  } finally {
    release();
  }
}

function land(db: Database, ship: ShipOf): void {
  const { trace, order, checkout } = ship;
  const record = (later: Later) => recordAs(trace, db, order, { kind: "factory", cause: ship.cause }, later);
  ownerIdentity(checkout, ship.env);
  record({ action: "ship_started", details: {} });
  if (ship.config.ship === undefined) {
    record({ action: "ship_stopped", code: "ship_unset", details: {} });
    throw refuseShip("ship_unset", { order, project: ship.project });
  }
  if (!isClean(checkout, "no")) dirty({ ...ship, record }, "tracked files have uncommitted changes");
  const { head } = orderState(db, order);
  invariant(head !== null, `order ${order} has a recorded head when it ships`);
  const shipping: Shipping = { ...ship, workspace: workspaceOf(ship.project, order), record };
  const landing = rebase(shipping, head);
  const check = checked(shipping, landing);
  landOnDefault(shipping, landing);
  const kept = removeWorkspace(trace, checkout, shipping.workspace);
  record({ action: "ship_landed", details: { head: landing.head, kept }, evidence: [check] });
}

function dirty(
  { order, checkout, record }: Pick<Shipping, "order" | "checkout" | "record">,
  reason: string,
): never {
  record({ action: "ship_stopped", code: "checkout_dirty", details: { checkout, reason } });
  throw refuseShip("checkout_dirty", { order, checkout, reason });
}

type Landing = { readonly head: string; readonly onto: string };

function rebase(shipping: Shipping, head: string): Landing {
  const { trace, order, checkout, defaultBranch, workspace, record, env } = shipping;
  settleWorkspace(trace, workspace, head);
  const onto = tipOf(checkout, defaultBranch);
  const before = commitsBetween(checkout, onto, head);
  if (before.length === 0) return { head, onto };
  const rebased = rebaseOnto(trace, workspace, onto, env);
  if (rebased.kind === "conflict") {
    record({ action: "ship_stopped", code: "ship_conflict", details: { onto, paths: rebased.paths } });
    throw refuseShip("ship_conflict", { order, onto, paths: rebased.paths });
  }
  if (rebased.kind === "failed") {
    record({ action: "ship_stopped", code: "rebase_failed", details: { onto, reason: rebased.reason } });
    throw refuseShip("rebase_failed", { order, onto, reason: rebased.reason });
  }
  const moved = tipOf(workspace.dir, workspace.branch);
  const commits = movedCommits(before, commitsBetween(checkout, onto, moved));
  record({ action: "branch_rebased", details: { head: moved, onto, commits }, evidence: [] });
  return { head: moved, onto };
}

function checked({ trace, order, env, workspace, record }: Shipping, { head }: Landing) {
  const task = checkTask(workspace.dir);
  if (task === null) {
    record({ action: "ship_stopped", code: "ship_no_check", details: { head } });
    throw refuseShip("ship_no_check", { order, head });
  }
  const check = judge(trace, workspace.dir, task.commandLine, env);
  if (check.exitCode !== 0) {
    record({ action: "ship_stopped", code: "ship_check_failed", details: { head }, evidence: [check] });
    throw refuseShip("ship_check_failed", { order, head, command: check.command, exitCode: check.exitCode });
  }
  return check;
}

function landOnDefault(shipping: Shipping, { head, onto }: Landing): void {
  const { trace, checkout, defaultBranch } = shipping;
  if (checkedOutBranch(checkout) !== defaultBranch) {
    moveBranch(trace, checkout, defaultBranch, head, onto);
    return;
  }
  const landed = fastForward(trace, checkout, head);
  if (!landed.ok) dirty(shipping, landed.reason);
}
