export type Role = "operator" | "planner" | "builder" | "reviewer";

export const ROLES: readonly Role[] = ["operator", "planner", "builder", "reviewer"];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export const READ_ONLY_ROLES: readonly Role[] = ["planner", "reviewer"];

export function isReadOnly(role: Role): boolean {
  return (READ_ONLY_ROLES as readonly string[]).includes(role);
}

export const ROLES_SQL = ROLES.map((role) => `'${role}'`).join(",");
