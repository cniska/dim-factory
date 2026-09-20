import { describe, expect, test } from "bun:test";
import { randomWorkerName, WORKER_NAMES } from "./worker-name";

describe("naming a factory worker", () => {
  test("names read as a word and a number", () => {
    expect(randomWorkerName(new Set())).toMatch(/^[a-z]+-\d{1,2}$/);
  });

  test("a name nothing holds is never drawn twice", () => {
    const taken = new Set<string>();
    for (let issued = 0; issued < 500; issued += 1) {
      const name = randomWorkerName(taken);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }

    expect(taken.size).toBe(500);
  });

  test("the draw skips a held name rather than colliding with it", () => {
    const first = randomWorkerName(new Set(), () => 0);

    expect(randomWorkerName(new Set([first]), () => 0)).not.toBe(first);
  });

  test("a full vocabulary is refused rather than handed a repeat", () => {
    expect(() => randomWorkerName(new Set(WORKER_NAMES))).toThrow(/worker names is held/);
  });
});
