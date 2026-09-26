import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, type Env } from "./paths";
import { pidIsAlive } from "./pid";

export class LockHeldError extends Error {
  readonly code = "LOCK_HELD";
  constructor(path: string, pid: number) {
    super(`another dim run holds ${path} (pid ${pid})`);
  }
}

function holderIsAlive(holder: number): boolean {
  return Number.isInteger(holder) && holder > 0 && pidIsAlive(holder);
}

function holderOf(pidFile: string): number {
  try {
    return Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return Number.NaN;
  }
}

function tryInstall(staging: string, path: string): boolean {
  try {
    renameSync(staging, path);
    return true;
  } catch {
    return false;
  }
}

function clearAbandoned(path: string): void {
  const aside = `${path}.stale.${process.pid}`;
  rmSync(aside, { recursive: true, force: true });
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  const holder = holderOf(join(aside, "pid"));
  if (holderIsAlive(holder)) {
    renameSync(aside, path);
    throw new LockHeldError(path, holder);
  }
  rmSync(aside, { recursive: true, force: true });
}

function claim(path: string, pidFile: string): void {
  const staging = `${path}.${process.pid}`;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "pid"), String(process.pid));
    if (tryInstall(staging, path)) return;
    const holder = holderOf(pidFile);
    if (holderIsAlive(holder)) throw new LockHeldError(path, holder);
    clearAbandoned(path);
    if (tryInstall(staging, path)) return;
    throw new LockHeldError(path, holderOf(pidFile));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function release(path: string): void {
  const dropped = `${path}.released.${process.pid}`;
  try {
    renameSync(path, dropped);
  } catch {
    return;
  }
  rmSync(dropped, { recursive: true, force: true });
}

export function withLock<T>(fn: () => T, env: Env = process.env): T {
  const path = join(dataDir(env), "lock");
  const pidFile = join(path, "pid");
  mkdirSync(dataDir(env), { recursive: true });

  claim(path, pidFile);

  let result: T;
  try {
    result = fn();
  } catch (error) {
    release(path);
    throw error;
  }
  if (result instanceof Promise) return result.finally(() => release(path)) as T;
  release(path);
  return result;
}
