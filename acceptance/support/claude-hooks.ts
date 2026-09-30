import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type HookEntry = {
  readonly matcher?: string;
  readonly hooks?: readonly { readonly type?: string; readonly command?: string }[];
};

export type ClaudeHooks = Readonly<Record<string, readonly HookEntry[]>>;

export const settingsPath = (root: string): string => join(root, ".claude", "settings.json");

export function settingsHooks(root: string): ClaudeHooks {
  const path = settingsPath(root);
  if (!existsSync(path)) return {};
  return (JSON.parse(readFileSync(path, "utf8")) as { readonly hooks?: ClaudeHooks }).hooks ?? {};
}

export function mergeHooks(...sources: readonly ClaudeHooks[]): ClaudeHooks {
  const events = new Set(sources.flatMap((source) => Object.keys(source)));
  return Object.fromEntries(
    [...events].map((event) => [event, sources.flatMap((source) => source[event] ?? [])]),
  );
}

const commandsOf = (entries: readonly HookEntry[]): readonly string[] =>
  entries.flatMap((entry) => entry.hooks ?? []).flatMap((hook) => (hook.command ? [hook.command] : []));

export function hookCommands(hooks: ClaudeHooks, event: string, tool?: string): readonly string[] {
  return commandsOf(
    (hooks[event] ?? []).filter(
      (entry) =>
        entry.matcher === undefined ||
        entry.matcher === "" ||
        entry.matcher === "*" ||
        (tool !== undefined && new RegExp(`^(${entry.matcher})$`).test(tool)),
    ),
  );
}

export function everyHookCommand(hooks: ClaudeHooks): readonly string[] {
  return commandsOf(Object.values(hooks).flat());
}

export function fireHooksSync(
  hooks: ClaudeHooks,
  event: string,
  payload: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string>>,
  cwd: string,
  tool?: string,
): void {
  const body = JSON.stringify({ ...payload, hook_event_name: event, cwd });
  for (const command of hookCommands(hooks, event, tool)) {
    Bun.spawnSync(["sh", "-c", command], { cwd, env, stdin: new TextEncoder().encode(body) });
  }
}
