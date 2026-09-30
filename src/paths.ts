import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Env = Record<string, string | undefined>;

const CONFIG_NAME = "dim";
const DATA_NAME = "dim-factory";

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

function xdgBase(env: Env, variable: string, fallback: readonly string[]): string {
  const value = env[variable];
  return value && isAbsolute(value) ? value : join(resolveHomeDir(env), ...fallback);
}

export function configDir(env: Env = process.env): string {
  return join(xdgBase(env, "XDG_CONFIG_HOME", [".config"]), CONFIG_NAME);
}

function dataDir(env: Env): string {
  return join(xdgBase(env, "XDG_DATA_HOME", [".local", "share"]), DATA_NAME);
}

export function stateDir(env: Env = process.env): string {
  return join(xdgBase(env, "XDG_STATE_HOME", [".local", "state"]), DATA_NAME);
}

function recordDir(env: Env): string {
  return join(dataDir(env), "record");
}

export function dbPath(env: Env = process.env): string {
  return join(recordDir(env), "sessions.db");
}

export function spoolDir(env: Env = process.env): string {
  return join(recordDir(env), "spool");
}

export function locksDir(env: Env = process.env): string {
  return join(stateDir(env), "locks");
}

export function workspaceDir(project: string, order: string, env: Env = process.env): string {
  return join(dataDir(env), "workspaces", ...project.split("/"), order);
}

export function workerHomeDir(worker: string, env: Env = process.env): string {
  return join(dataDir(env), "workers", worker, "home");
}

export function workerSessionsDir(worker: string, env: Env = process.env): string {
  return join(dataDir(env), "workers", worker, "sessions");
}

export function claudeProjectsDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".claude", "projects");
}

export function codexDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".codex");
}
