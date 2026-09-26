import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Env = Record<string, string | undefined>;

const APP_NAME = "dim-factory";

export function resolveHomeDir(env: Env = process.env): string {
  const envHome = env.HOME;
  if (envHome && envHome.trim().length > 0) return envHome;
  return homedir();
}

export function tildePath(path: string, env: Env = process.env): string {
  const home = resolveHomeDir(env);
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function dataDir(env: Env = process.env): string {
  const home = env.DIM_HOME;
  if (home && home.trim().length > 0) return home;
  const xdg = env.XDG_DATA_HOME;
  if (xdg && xdg.trim().length > 0 && isAbsolute(xdg)) return join(xdg, APP_NAME);
  return join(resolveHomeDir(env), ".local", "share", APP_NAME);
}

export function dbPath(env: Env = process.env): string {
  return join(dataDir(env), "sessions.db");
}

export function claudeProjectsDir(env: Env = process.env): string {
  return env.DIM_CLAUDE_PROJECTS ?? join(resolveHomeDir(env), ".claude", "projects");
}

export function codexDir(env: Env = process.env): string {
  return env.DIM_CODEX_DIR ?? join(resolveHomeDir(env), ".codex");
}
