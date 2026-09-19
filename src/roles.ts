/**
 * What a hand is called in as, fixed when it is issued: the operator runs the line and the
 * rest are what it hands work to, while the station says where the work is. One list, because
 * a role the record refuses and the router answers for is the same word meaning two things.
 */
export type Role =
  | "operator"
  | "planner"
  | "builder"
  | "simplifier"
  | "reviewer"
  | "checker"
  | "judge"
  | "searcher";

export const ROLES: readonly Role[] = [
  "operator",
  "planner",
  "builder",
  "simplifier",
  "reviewer",
  "checker",
  "judge",
  "searcher",
];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Binds at creation only: a table already on disk keeps the CHECK it was born with. */
export const ROLES_SQL = ROLES.map((role) => `'${role}'`).join(",");
