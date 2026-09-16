import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, type Env } from "./paths";

export class LockHeldError extends Error {
  readonly code = "LOCK_HELD";
  constructor(path: string, pid: number) {
    super(`another dim run holds ${path} (pid ${pid})`);
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 tests for the process without touching it
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Only sync writes the database, and never two at once. mkdir is atomic on APFS,
 * which is all this needs; macOS ships no flock(1). The pid file is what makes
 * it safe to run unattended: a killed run leaves the directory behind, and
 * without this the scheduled agent would fail every 15 minutes forever.
 */
export function withLock<T>(fn: () => T, env: Env = process.env): T {
  const path = join(dataDir(env), "lock");
  const pidFile = join(path, "pid");
  mkdirSync(dataDir(env), { recursive: true });

  try {
    mkdirSync(path);
  } catch {
    const holder = Number(existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : Number.NaN);
    if (Number.isInteger(holder) && pidIsAlive(holder)) throw new LockHeldError(path, holder);
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path);
  }

  writeFileSync(pidFile, String(process.pid));
  try {
    return fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
