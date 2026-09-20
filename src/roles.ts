/**
 * What a hand is called in as, fixed when it is issued. A role exists where the record must
 * tell one hand from another, or where a gate must refuse that hand something: a kind of
 * agent the factory does not spawn writes no rows and is not a role.
 */
export type Role = "operator" | "planner" | "builder" | "reviewer";

export const ROLES: readonly Role[] = ["operator", "planner", "builder", "reviewer"];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * The second axis, independent of identity: every hand writes its own rows, and these two
 * may not change the tree they read. A planner that edits has silently done the build, and
 * a reviewer that edits answers a finding by overwriting the work it was sent to read.
 */
export const READ_ONLY_ROLES: readonly Role[] = ["planner", "reviewer"];

export function isReadOnly(role: Role): boolean {
  return (READ_ONLY_ROLES as readonly string[]).includes(role);
}

/** Binds at creation only: a table already on disk keeps the CHECK it was born with. */
export const ROLES_SQL = ROLES.map((role) => `'${role}'`).join(",");
