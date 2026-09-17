import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config-error";
import { hookCommand, wakeCommand } from "./hooks";
import { readJsonc } from "./jsonc";
import { codexDir, type Env } from "./paths";

/**
 * Codex runs a hook written into `hooks.json` only where `config.toml` records a
 * `trusted_hash` for it under `[hooks.state]`, keyed by position:
 * `<hooks.json path>:<event>:<entry index>:<hook index>`. Trust is therefore
 * positional — another tool inserting an entry ahead of dim's moves it to a key
 * that was approved for a different command, and Codex stops running it with
 * nothing saying so.
 *
 * What the key records is a hash of the entry as Codex computes it, and this
 * does not recompute that hash. So a missing key proves the hook will not run,
 * and a present one says only that this position was approved at some point.
 */
export type TrustState = {
  event: string;
  command: string;
  /** Null where the hook is not in hooks.json at all, so there is no position to trust. */
  key: string | null;
  recorded: boolean;
};

export function codexConfigPath(env: Env = process.env): string {
  return join(codexDir(env), "config.toml");
}

/** `SessionStart` in hooks.json is `session_start` in the trust key. */
function keyEvent(event: string): string {
  return event.replace(/(?<=[a-z])(?=[A-Z])/g, "_").toLowerCase();
}

type HookEntry = { hooks?: { command?: string }[] };

function recordedKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  let parsed: { hooks?: { state?: Record<string, { trusted_hash?: unknown }> } };
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as typeof parsed;
  } catch (error) {
    // An empty set reads as "nothing is trusted", which sends the reader to
    // approve a hook in Codex when what is wrong is the file.
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError("parse", path, `${path}: ${detail}`);
  }
  const state = parsed.hooks?.state ?? {};
  return new Set(Object.keys(state).filter((k) => typeof state[k]?.trusted_hash === "string"));
}

/** Where a command sits in an event's entries, as the trust key numbers it. */
function positionOf(entries: HookEntry[], command: string): [number, number] | null {
  for (const [entry, e] of entries.entries()) {
    const hook = (e.hooks ?? []).findIndex((h) => h.command === command);
    if (hook !== -1) return [entry, hook];
  }
  return null;
}

export function planCodexTrust(env: Env = process.env): TrustState[] {
  const hooksPath = join(codexDir(env), "hooks.json");
  const config = readJsonc<{ hooks?: Record<string, HookEntry[]> }>(hooksPath) ?? {};
  const recorded = recordedKeys(codexConfigPath(env));

  const wanted: [string, string][] = [
    ["SessionStart", hookCommand("codex", env)],
    ["SessionStart", wakeCommand("codex")],
    ["SessionEnd", hookCommand("codex", env)],
  ];
  return wanted.map(([event, command]) => {
    const at = positionOf(config.hooks?.[event] ?? [], command);
    const key = at ? `${hooksPath}:${keyEvent(event)}:${at[0]}:${at[1]}` : null;
    return { event, command, key, recorded: key !== null && recorded.has(key) };
  });
}
