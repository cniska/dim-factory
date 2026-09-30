import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] };
export type ClaudeHooks = Record<string, HookEntry[]>;

export function settingsHooks(root: string): ClaudeHooks {
  const path = join(root, ".claude", "settings.json");
  if (!existsSync(path)) return {};
  return (JSON.parse(readFileSync(path, "utf8")) as { hooks?: ClaudeHooks }).hooks ?? {};
}

export function mergeHooks(...sources: ClaudeHooks[]): ClaudeHooks {
  const merged: ClaudeHooks = {};
  for (const source of sources) {
    for (const [event, entries] of Object.entries(source))
      merged[event] = [...(merged[event] ?? []), ...entries];
  }
  return merged;
}

export function hookCommands(hooks: ClaudeHooks, event: string, tool?: string): string[] {
  return (hooks[event] ?? [])
    .filter(
      (entry) => !entry.matcher || (tool !== undefined && new RegExp(`^(${entry.matcher})$`).test(tool)),
    )
    .flatMap((entry) => entry.hooks ?? [])
    .flatMap((hook) => (hook.command ? [hook.command] : []));
}

export function fireHooksSync(
  hooks: ClaudeHooks,
  event: string,
  payload: Record<string, unknown>,
  env: Record<string, string | undefined>,
  cwd: string,
  tool?: string,
): void {
  const body = JSON.stringify({ ...payload, hook_event_name: event, cwd });
  for (const command of hookCommands(hooks, event, tool)) {
    Bun.spawnSync(["sh", "-c", command], { cwd, env, stdin: new TextEncoder().encode(body) });
  }
}
