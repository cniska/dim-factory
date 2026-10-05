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

function xdgBase(env: Env, variable: string, fallback: readonly string[]): string {
  const value = env[variable];
  return value && isAbsolute(value) ? value : join(resolveHomeDir(env), ...fallback);
}

export function xdgHomes(env: Env): Record<"XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME", string> {
  return {
    XDG_CONFIG_HOME: xdgBase(env, "XDG_CONFIG_HOME", [".config"]),
    XDG_DATA_HOME: xdgBase(env, "XDG_DATA_HOME", [".local", "share"]),
    XDG_STATE_HOME: xdgBase(env, "XDG_STATE_HOME", [".local", "state"]),
  };
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

export function tracePath(env: Env = process.env): string {
  return join(stateDir(env), "trace.jsonl");
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

export function workspacesDir(env: Env = process.env): string {
  return join(dataDir(env), "workspaces");
}

export function workspaceDir(project: string, order: string, env: Env = process.env): string {
  return join(workspacesDir(env), ...project.split("/"), order);
}

export function workerHomeDir(worker: string, env: Env = process.env): string {
  return join(dataDir(env), "workers", worker, "home");
}

export function workerSessionsDir(worker: string, env: Env = process.env): string {
  return join(dataDir(env), "workers", worker, "sessions");
}

export function claudeDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".claude");
}

export function claudeProjectsDir(env: Env = process.env): string {
  return join(claudeDir(env), "projects");
}

export function codexDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".codex");
}

export function grokDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".grok");
}

export function piSessionsDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".pi", "agent", "sessions");
}

export function ompSessionsDir(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".omp", "agent", "sessions");
}
