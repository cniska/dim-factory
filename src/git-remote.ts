import { existsSync, statSync } from "node:fs";
import { remoteSlug } from "./remote-slug";

/**
 * A checkout's identity as `owner/repo`, taken from its remote. The idea is
 * Acolyte's (`acolyte/src/git-remote.ts`): the host is dropped, so a repository
 * keeps its name when it moves between forges, and a worktree resolves to the
 * same label as the checkout it belongs to.
 *
 * dim needs it for something Acolyte does not: a local path names a directory on
 * one machine, so it can neither group a worktree with its parent nor identify
 * the same repository on another machine.
 */
export function repositoryLabel(url: string): string | null {
  const trimmed = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed)?.[0];
  const addressed = trimmed.slice(scheme?.length ?? 0).replace(/^[^/@]*@/, "");
  // A filesystem path names a directory, not a repository others can share, and
  // a single leading letter before a colon is a Windows drive.
  if (addressed.startsWith("/")) return null;
  if (!scheme && !/^[^/:]{2,}:/.test(addressed)) return null;

  // `host:path` addresses the same repository as `ssh://host/path`. Only the URL
  // form carries a port, so in the shorthand a leading number is a path segment.
  const rooted = scheme
    ? addressed.replace(/^([^/:]+)(:\d+)?/, "$1")
    : addressed.replace(/^([^/:]+):/, "$1/");
  const [host, ...ownerAndName] = rooted
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (!host || ownerAndName.length < 2) return null;
  return ownerAndName.join("/").toLowerCase();
}

function git(args: string[], cwd: string): string | null {
  try {
    if (!statSync(cwd).isDirectory()) return null;
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
  try {
    const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return proc.success ? new TextDecoder().decode(proc.stdout).trim() || null : null;
  } catch (error) {
    if (isMissingPath(error) && !existsSync(cwd)) return null;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * Read from the common directory rather than the worktree's own, because a
 * worktree has no remote of its own and would otherwise look like a repository
 * nobody else shares.
 */
export function labelFor(repoRoot: string): string | null {
  const url =
    git(["config", "--get", "remote.origin.url"], repoRoot) ??
    git(["config", "--get", "remote.upstream.url"], repoRoot);
  return url ? repositoryLabel(url) : null;
}

export function checkoutSlug(repoRoot: string): string | null {
  const url = git(["config", "--get", "remote.origin.url"], repoRoot);
  return url ? remoteSlug(url) : null;
}
