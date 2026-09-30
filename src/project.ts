import type { Database } from "bun:sqlite";
import { checkoutRoot } from "./git-checkout";
import { originLabel } from "./git-remote";
import { remoteHeadBranch } from "./git-tree";
import { sessionDirs } from "./hooks-sessions";

export type Checkout = { readonly root: string; readonly project: string };

export function checkoutAt(dir: string): Checkout | null {
  const root = checkoutRoot(dir);
  if (root === null) return null;
  const project = originLabel(root);
  return project === null ? null : { root, project };
}

export function lastCheckoutOf(db: Database, project: string): Checkout | null {
  for (const dir of sessionDirs(db)) {
    const seen = checkoutAt(dir);
    if (seen?.project === project) return seen;
  }
  return null;
}

export function defaultBranch(root: string): string | null {
  return remoteHeadBranch(root, "origin");
}
