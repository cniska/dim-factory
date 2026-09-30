import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ClaudeSettings = {
  readonly permissions?: { readonly deny?: readonly string[] };
  readonly sandbox?: {
    readonly enabled?: boolean;
    readonly autoAllowBashIfSandboxed?: boolean;
    readonly filesystem?: { readonly denyWrite?: readonly string[] };
  };
};

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

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

function ruleRoot(rule: string, project: string): string {
  return rule.startsWith("//") ? real(rule.slice(1)) : real(resolve(project, rule.replace(/^\//, "")));
}

function deniedEdits(settings: ClaudeSettings, project: string): readonly string[] | "all" {
  const deny = settings.permissions?.deny ?? [];
  if (deny.some((rule) => ["Write", "Edit", "NotebookEdit"].includes(rule))) return "all";
  return deny.flatMap((rule) => {
    const matched = /^Edit\((.+?)(\/\*\*)?\)$/.exec(rule);
    return matched?.[1] ? [ruleRoot(matched[1], project)] : [];
  });
}

export function writeAllowed(
  settings: ClaudeSettings,
  mode: PermissionMode,
  project: string,
  path: string,
): boolean {
  if (mode !== "acceptEdits" && mode !== "bypassPermissions") return false;
  const denied = deniedEdits(settings, project);
  return denied !== "all" && !denied.some((root) => within(real(resolve(project, path)), root));
}

export function bashAllowed(settings: ClaudeSettings, mode: PermissionMode): boolean {
  if (settings.permissions?.deny?.includes("Bash")) return false;
  return (
    mode === "bypassPermissions" ||
    (settings.sandbox?.enabled === true && settings.sandbox.autoAllowBashIfSandboxed === true)
  );
}

const quoted = (path: string) => JSON.stringify(path);

export function sandboxed(
  settings: ClaudeSettings,
  writableDirs: readonly string[],
  command: string,
): string[] {
  if (!settings.sandbox?.enabled) return ["sh", "-c", command];
  const writable = writableDirs.map(real);
  const denied = (settings.sandbox.filesystem?.denyWrite ?? []).map(real);
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") (literal "/dev/tty") ${writable.map((path) => `(subpath ${quoted(path)})`).join(" ")})`,
    ...(denied.length > 0
      ? [`(deny file-write* ${denied.map((path) => `(subpath ${quoted(path)})`).join(" ")})`]
      : []),
  ].join("\n");
  return ["sandbox-exec", "-p", profile, "sh", "-c", command];
}
