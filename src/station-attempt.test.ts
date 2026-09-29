import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdOrder } from "./station-attempt";

const homes: string[] = [];

function env(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "dim-hold-"));
  homes.push(home);
  return { DIM_HOME: home };
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop() as string, { recursive: true, force: true });
});

describe("holding an order while its station starts", () => {
  test("refuses a second station on the order until the first releases it", () => {
    const machine = env();
    const hold = holdOrder("order-1", machine);
    expect(() => holdOrder("order-1", machine)).toThrow(expect.objectContaining({ code: "LOCK_HELD" }));
    hold.release();
    expect(() => holdOrder("order-1", machine).release()).not.toThrow();
  });

  test("holds each order apart, and each data directory apart", () => {
    const machine = env();
    const hold = holdOrder("order-1", machine);
    expect(() => holdOrder("order-2", machine).release()).not.toThrow();
    expect(() => holdOrder("order-1", env()).release()).not.toThrow();
    hold.release();
  });

  test("releases once, however many times a station lets go", () => {
    const machine = env();
    const hold = holdOrder("order-1", machine);
    hold.release();
    const next = holdOrder("order-1", machine);
    hold.release();
    expect(() => holdOrder("order-1", machine)).toThrow(expect.objectContaining({ code: "LOCK_HELD" }));
    next.release();
  });

  test("lets go when the scope that holds it ends", () => {
    const machine = env();
    {
      using _hold = holdOrder("order-1", machine);
      expect(() => holdOrder("order-1", machine)).toThrow(expect.objectContaining({ code: "LOCK_HELD" }));
    }
    expect(() => holdOrder("order-1", machine).release()).not.toThrow();
  });
});
