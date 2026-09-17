import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockHeldError, withLock } from "./lock";
import type { Env } from "./paths";

const roots: string[] = [];

function newRoot(): { env: Env; lock: string } {
  const root = mkdtempSync(join(tmpdir(), "dim-lock-"));
  roots.push(root);
  return { env: { DIM_HOME: root }, lock: join(root, "lock") };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("the write lock", () => {
  test("releases after synchronous work", () => {
    const { env, lock } = newRoot();
    expect(withLock(() => existsSync(lock), env)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("releases when synchronous work throws", () => {
    const { env, lock } = newRoot();
    expect(() =>
      withLock(() => {
        throw new Error("mid-write");
      }, env),
    ).toThrow("mid-write");
    expect(existsSync(lock)).toBe(false);
  });

  // Releasing when `fn` returns would hand the lock to a second run while the
  // first is still writing, because an async `fn` has only started by then.
  test("stays held until asynchronous work finishes", async () => {
    const { env, lock } = newRoot();
    let heldMidway = false;
    const running = withLock(async () => {
      await Bun.sleep(20);
      heldMidway = existsSync(lock);
    }, env);

    expect(existsSync(lock)).toBe(true);
    await running;
    expect(heldMidway).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("a second run is refused while asynchronous work is still in flight", async () => {
    const { env, lock } = newRoot();
    const running = withLock(async () => {
      await Bun.sleep(20);
    }, env);

    expect(() => withLock(() => null, env)).toThrow(LockHeldError);
    await running;
    expect(existsSync(lock)).toBe(false);
  });

  test("releases when asynchronous work rejects", async () => {
    const { env, lock } = newRoot();
    const running = withLock(async () => {
      await Bun.sleep(5);
      throw new Error("mid-write");
    }, env);

    await expect(running).rejects.toThrow("mid-write");
    expect(existsSync(lock)).toBe(false);
  });

  test("a lock left behind by a killed run is taken over", () => {
    const { env, lock } = newRoot();
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "999999");
    expect(withLock(() => existsSync(lock), env)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});
