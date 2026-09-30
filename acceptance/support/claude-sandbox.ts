import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ClaudeSettings = {
  permissions?: { deny?: string[] };
  sandbox?: { enabled?: boolean; filesystem?: { denyWrite?: string[] } };
};

function real(path: string): string {
  let probe = resolve(path);
  const rest: string[] = [];
  while (!existsSync(probe) && dirname(probe) !== probe) {
    rest.unshift(probe.slice(dirname(probe).length + 1));
    probe = dirname(probe);
  }
  return [realpathSync(probe), ...rest].join("/");
}

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

function deniedEditRoots(settings: ClaudeSettings): string[] | "all" {
  const deny = settings.permissions?.deny ?? [];
  if (deny.includes("Write") || deny.includes("Edit")) return "all";
  return deny.flatMap((rule) => {
    const matched = /^Edit\((.+?)(\/\*\*)?\)$/.exec(rule);
    return matched?.[1] ? [real(matched[1].replace(/^\/\//, "/"))] : [];
  });
}

export function writeRefused(settings: ClaudeSettings, path: string): boolean {
  const roots = deniedEditRoots(settings);
  return roots === "all" || roots.some((root) => within(real(path), root));
}

const quoted = (path: string) => JSON.stringify(path);

export function sandboxed(settings: ClaudeSettings, writableDirs: string[], command: string): string[] {
  if (!settings.sandbox?.enabled) return ["sh", "-c", command];
  const writable = writableDirs.map(real);
  const denied = (settings.sandbox.filesystem?.denyWrite ?? []).map(real);
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") (literal "/dev/tty") ${writable.map((path) => `(subpath ${quoted(path)})`).join(" ")})`,
    ...(denied.length
      ? [`(deny file-write* ${denied.map((path) => `(subpath ${quoted(path)})`).join(" ")})`]
      : []),
  ].join("\n");
  return ["sandbox-exec", "-p", profile, "sh", "-c", command];
}
