export function branchOf(order: string): string {
  return `dim/${order}`;
}

export type Workspace = { readonly dir: string; readonly branch: string };

export type Rebased =
  | { readonly kind: "rebased" }
  | { readonly kind: "conflict"; readonly paths: readonly string[] }
  | { readonly kind: "failed"; readonly reason: string };

export type Kept =
  | { readonly kind: "workspace"; readonly dir: string; readonly reason: string }
  | { readonly kind: "branch"; readonly branch: string; readonly reason: string };
