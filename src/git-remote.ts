import { configValue } from "./git";

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

export function originLabel(repoRoot: string): string | null {
  const url = configValue(repoRoot, "remote.origin.url");
  return url ? repositoryLabel(url) : null;
}
