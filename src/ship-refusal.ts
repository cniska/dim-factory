export type ShipRefusalCode =
  | "ship_no_method"
  | "ship_invalid_method"
  | "ship_pull_request_unbuilt"
  | "ship_no_trunk"
  | "ship_wrong_head"
  | "ship_dirty_trunk"
  | "ship_no_branch"
  | "ship_unrecorded_head"
  | "ship_no_worktree"
  | "ship_nested_repository"
  | "ship_dirty_worktree"
  | "ship_rebase_conflict"
  | "ship_rebase_failed"
  | "ship_rebase_unpaired"
  | "ship_check_failed"
  | "ship_patch_changed"
  | "ship_not_fast_forward"
  | "ship_unsigned"
  | "ship_not_landed";

/** Carries a code because a caller deciding which condition failed must not match on prose. */
export class ShipRefusal extends Error {
  constructor(
    readonly code: ShipRefusalCode,
    message: string,
  ) {
    super(message);
  }
}
