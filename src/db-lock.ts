import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { refuseRecord } from "./db-contract";
import { type Env, locksDir } from "./paths";
import { pidIsAlive } from "./pid";

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

function clearAbandoned(path: string): number | null {
  const aside = `${path}.stale.${process.pid}`;
  rmSync(aside, { recursive: true, force: true });
  try {
    renameSync(path, aside);
  } catch {
    return null;
  }
  const holder = holderOf(join(aside, "pid"));
  if (holderIsAlive(holder)) {
    renameSync(aside, path);
    return holder;
  }
  rmSync(aside, { recursive: true, force: true });
  return null;
}

type Claim = { readonly kind: "claimed" } | { readonly kind: "held"; readonly holder: number };

function claim(path: string): Claim {
  mkdirSync(dirname(path), { recursive: true });
  const pidFile = join(path, "pid");
  const staging = `${path}.${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "pid"), String(process.pid));
    if (tryInstall(staging, path)) return { kind: "claimed" };
    const holder = holderOf(pidFile);
    if (holderIsAlive(holder)) return { kind: "held", holder };
    const living = clearAbandoned(path);
    if (living !== null) return { kind: "held", holder: living };
    if (tryInstall(staging, path)) return { kind: "claimed" };
    return { kind: "held", holder: holderOf(pidFile) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
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

export function tryClaimPathLock(path: string): (() => void) | null {
  return claim(path).kind === "claimed" ? releaser(path) : null;
}

function claimPathLock(path: string): () => void {
  const claimed = claim(path);
  if (claimed.kind === "held") throw refuseRecord("lock_held", { path, pid: claimed.holder });
  return releaser(path);
}

function releaser(path: string): () => void {
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    release(path);
  };
}

export function withPathLock<T>(path: string, fn: () => T): T {
  const released = claimPathLock(path);
  let result: T;
  try {
    result = fn();
  } catch (error) {
    released();
    throw error;
  }
  if (result instanceof Promise) result.then(released, released);
  else released();
  return result;
}

export function withLock<T>(fn: () => T, env: Env = process.env): T {
  return withPathLock(join(locksDir(env), "record"), fn);
}
