import { describe, expect, test } from "bun:test";
import { nextWorkerName, wordFor } from "./worker-name";

describe("naming a factory worker", () => {
  test("names read as a word and a number", () => {
    expect(nextWorkerName(0, 0)).toMatch(/^[a-z]+-\d+$/);
  });

  test("the words are walked in turn, so the second worker is not the first's word", () => {
    expect(wordFor(0)).not.toBe(wordFor(1));
  });

  test("no two workers are handed the same name", () => {
    const issued = new Set<string>();
    const onWord = new Map<string, number>();
    for (let workers = 0; workers < 5000; workers += 1) {
      const word = wordFor(workers);
      const taken = onWord.get(word) ?? 0;
      issued.add(nextWorkerName(workers, taken));
      onWord.set(word, taken + 1);
    }

    expect(issued.size).toBe(5000);
  });

  test("the number is what grows, so the vocabulary never runs out", () => {
    const word = wordFor(0);

    expect(nextWorkerName(0, 999)).toBe(`${word}-1000`);
  });
});
