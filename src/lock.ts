import { mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir, type Env } from "./paths";

export class LockHeldError extends Error {
  readonly code = "LOCK_HELD";
  constructor(path: string) {
    super(`another dim run holds ${path}`);
  }
}

/**
 * Only sync writes the database, and never two at once. mkdir is atomic on
 * APFS, which is all this needs; macOS ships no flock(1).
 */
export function withLock<T>(fn: () => T, env: Env = process.env): T {
  const path = join(dataDir(env), "lock");
  mkdirSync(dataDir(env), { recursive: true });
  try {
    mkdirSync(path);
  } catch {
    throw new LockHeldError(path);
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(path);
    } catch {
      // the lock was already released
    }
  }
}
