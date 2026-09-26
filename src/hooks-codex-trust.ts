import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config-error";
import { readJsonc } from "./config-jsonc-file";
import { type HookEntry, hookConfigPath, wantedHooks } from "./hooks";
import { codexDir, type Env } from "./paths";

export type TrustState = {
  event: string;
  command: string;
  key: string | null;
  recorded: boolean;
};

export function codexConfigPath(env: Env = process.env): string {
  return join(codexDir(env), "config.toml");
}

function keyEvent(event: string): string {
  return event.replace(/(?<=[a-z])(?=[A-Z])/g, "_").toLowerCase();
}

function recordedKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  let parsed: { hooks?: { state?: Record<string, { trusted_hash?: unknown }> } };
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as typeof parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError("parse", path, `${path}: ${detail}`);
  }
  const state = parsed.hooks?.state ?? {};
  return new Set(Object.keys(state).filter((k) => typeof state[k]?.trusted_hash === "string"));
}

function positionOf(entries: HookEntry[], command: string): [number, number] | null {
  for (const [entry, e] of entries.entries()) {
    const hook = (e.hooks ?? []).findIndex((h) => h.command === command);
    if (hook !== -1) return [entry, hook];
  }
  return null;
}

export function planCodexTrust(env: Env = process.env): TrustState[] {
  const hooksPath = hookConfigPath("codex", env);
  const config = readJsonc<{ hooks?: Record<string, HookEntry[]> }>(hooksPath) ?? {};
  const recorded = recordedKeys(codexConfigPath(env));

  return wantedHooks("codex", env).map(({ event, command }) => {
    const at = positionOf(config.hooks?.[event] ?? [], command);
    const key = at ? `${hooksPath}:${keyEvent(event)}:${at[0]}:${at[1]}` : null;
    return { event, command, key, recorded: key !== null && recorded.has(key) };
  });
}
