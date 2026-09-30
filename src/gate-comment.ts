import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "./config";
import { ownersCover } from "./gate-hooks";
import { gitConfigValue, installedOwners, sharedHooksDir } from "./gate-install";
import { checkoutSlug, labelFor } from "./git-remote";
import type { Env } from "./paths";

export type CommentGate =
  | { readonly state: "unlabeled" }
  | { readonly state: "off" | "uncovered" | "armed"; readonly label: string }
  | { readonly state: "hooks-elsewhere"; readonly label: string; readonly hooksPath: string | null };

export function commentsBanned(root: string, at: string, env: Env): boolean {
  return readConfig({ env, root, at }).comments === "banned";
}

function canonicalPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

export function commentGateFor(root: string, at: string, env: Env): CommentGate {
  const label = labelFor(root);
  if (label === null) return { state: "unlabeled" };
  if (!commentsBanned(root, at, env)) return { state: "off", label };
  if (!ownersCover(installedOwners(env) ?? [], checkoutSlug(root))) return { state: "uncovered", label };
  const hooksPath = gitConfigValue(["--type=path", "--get", "core.hooksPath"], root, env);
  if (hooksPath === null || canonicalPath(root, hooksPath) !== canonicalPath(root, sharedHooksDir(env))) {
    return { state: "hooks-elsewhere", label, hooksPath };
  }
  return { state: "armed", label };
}
