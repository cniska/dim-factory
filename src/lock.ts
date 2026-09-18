import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

// A pid of 0 addresses the whole process group, which answers to signal 0, so an
// empty pid file would otherwise read as a holder that never dies.
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

// `renameSync` replaces the target only while the target is an empty directory,
// so a holder's own pid file is what refuses a second run.
function tryInstall(staging: string, path: string): boolean {
  try {
    renameSync(staging, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take away a lock whose holder is gone. Deleting it outright would act on a pid
 * read a moment earlier, and a run that took the lock in between would have its
 * live lock deleted. Moving the directory aside is the one step that cannot be
 * won twice, so whoever moves it is the only one that reads what it held, and
 * puts it back if it turns out to be someone's.
 */
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

/**
 * Install a lock directory that already names its holder. Built in place it
 * would exist for a moment with no pid file in it, and a second run reads that
 * as a lock left behind and takes it too.
 *
 * One retry, and no more: the first pass clears a directory a killed run left,
 * the second installs, and a pass that still loses lost to a run that is active,
 * which is the refusal this raises anyway.
 */
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

// Deleting in place empties the directory before it disappears, and an empty one
// is what `tryInstall` is allowed to replace. Moving it away first is what keeps
// the lock path whole or absent and never in between, which is the state
// `clearAbandoned` reads a pid out of.
function release(path: string): void {
  const dropped = `${path}.released.${process.pid}`;
  try {
    renameSync(path, dropped);
  } catch {
    return;
  }
  rmSync(dropped, { recursive: true, force: true });
}

/**
 * Only sync writes the database, and never two at once. macOS ships no flock(1),
 * and the pid file is what makes the lock safe to run unattended: a killed run
 * leaves the directory behind, and without a pid to test, the scheduled agent
 * would fail every 15 minutes forever.
 *
 * Held until the work is actually finished. A `fn` that returns a promise has
 * only started, and releasing when it returns would hand the lock to a second
 * run while the first is still writing.
 */
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
