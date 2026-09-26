import { existsSync, statSync } from "node:fs";
import { remoteSlug } from "./remote-slug";

export function repositoryLabel(url: string): string | null {
  const trimmed = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed)?.[0];
  const addressed = trimmed.slice(scheme?.length ?? 0).replace(/^[^/@]*@/, "");
  if (addressed.startsWith("/")) return null;
  if (!scheme && !/^[^/:]{2,}:/.test(addressed)) return null;

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
