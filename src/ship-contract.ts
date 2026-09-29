import { CodedError } from "./coded-error";
import type { Replay } from "./git-rebase-contract";
import type { WorkerHookReport } from "./worker-environment";

export type ShipOutcome = { landed: "already" | "fast_forward" | "rebased" };

export type ShipCleanup = { worktreeKept?: string; branchKept?: string };
export type ShipTeardown = ShipCleanup & { teardown?: WorkerHookReport };

type Branch = { branch: string; trunk: string };

const MESSAGES = {
  ship_no_method: (m: { reason: string }) => m.reason,
  ship_invalid_method: (m: { reason: string }) => m.reason,
  ship_pull_request_unbuilt: (m: { root: string }) =>
    `${m.root} declares dim.ship = pull-request, and shipping by pull request is not built`,
  ship_no_trunk: (m: { reason: string }) => m.reason,
  ship_wrong_head: (m: { root: string; trunk: string }) =>
    `${m.root} is not checked out on ${m.trunk}; check it out there before shipping`,
  ship_dirty_trunk: (m: { root: string }) =>
    `${m.root} has uncommitted changes or a moved submodule; commit or discard them before shipping`,
  ship_no_branch: (m: { root: string; branch: string }) =>
    `${m.root} has no branch named ${m.branch} to ship`,
  ship_unrecorded_head: (m: { branch: string; tip: string; last: string }) =>
    `${m.branch} is at ${m.tip}, not the order's last recorded commit ${m.last}; reset it there or record it first`,
  ship_not_carried: (m: Branch & { missing: readonly string[] }) =>
    `${m.branch} does not carry: ${m.missing.join(", ")}; nothing landed on ${m.trunk}`,
  ship_no_worktree: (m: { branch: string; root: string }) =>
    `${m.branch} is not checked out in any worktree of ${m.root}, so there is nowhere to rebase it`,
  ship_nested_repository: (m: { nested: string; worktree: string }) =>
    `${m.nested} is a git repository inside ${m.worktree}, which a rebase there would run git in`,
  ship_dirty_worktree: (m: { worktree: string; branch: string }) =>
    `${m.worktree} has uncommitted changes, which a rebase of ${m.branch} would have to carry`,
  ship_rebase_conflict: (
    m: Branch & {
      replay: Omit<Replay, "worktree">;
      worktree: string;
      paths: readonly string[];
      stoppedAt: string;
    },
  ) =>
    `${m.branch} conflicts with ${m.trunk} in ${m.paths.join(", ")}; ${m.worktree} is left mid-rebase for the builder to resolve`,
  ship_check_undeclared: (m: { trunk: string }) =>
    `${m.trunk} declares no check, so the rebased branch cannot be verified`,
  ship_check_redefined: (m: { task: string; source: string; trunk: string }) =>
    `the rebased branch redefines ${m.task} in ${m.source}, the check ${m.trunk} declares, so it is not verified by it`,
  ship_check_failed: (m: { command: string; exitCode: number; head: string }) =>
    `${m.command} exited ${m.exitCode} at the rebased head ${m.head}; the rebase is kept and the order is back at build; its output is on the ship run's check`,
  ship_patch_changed: (m: { orderId: string }) =>
    `rebasing ${m.orderId} onto the default branch changed a patch, so its approved review no longer covers it; it is back at review`,
  ship_not_fast_forward: (m: Branch) => `${m.branch} could not be fast-forwarded onto ${m.trunk}`,
  ship_not_landed: (m: Branch & { unreached: readonly string[] }) =>
    `${m.branch} landed on ${m.trunk} but does not reach: ${m.unreached.join(", ")}`,
};

export type ShipErrorCode = keyof typeof MESSAGES;
export type ShipErrorMeta<Code extends ShipErrorCode> = Parameters<(typeof MESSAGES)[Code]>[0];

export function fail<Code extends ShipErrorCode>(
  code: Code,
  meta: ShipErrorMeta<Code>,
): CodedError<Code, ShipErrorMeta<Code>> {
  const message = (MESSAGES[code] as (m: ShipErrorMeta<Code>) => string)(meta);
  return new CodedError(code, message, meta);
}
