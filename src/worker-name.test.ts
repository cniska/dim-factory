import { describe, expect, test } from "bun:test";
import { WORKER_NAME_SPACE, workerName } from "./worker-name";

describe("naming a factory worker", () => {
  test("the same agent is always the same worker", () => {
    expect(workerName("claude-builder")).toBe(workerName("claude-builder"));
  });

  test("names read as a word and a number", () => {
    expect(workerName("claude-builder")).toMatch(/^[a-z]+-\d{1,2}$/);
  });

  test("different agents get different names", () => {
    const names = ["claude-builder", "codex-fixer", "codex-reviewer", "claude-planner"].map(workerName);

    expect(new Set(names).size).toBe(names.length);
  });

  // A name labels a card and `agent_id` is what anything joins on, so collisions are
  // tolerable — but they have to stay rare enough that the wall reads as distinct workers.
  test("a thousand agents draw nearly a thousand names", () => {
    const names = new Set(Array.from({ length: 1000 }, (_, index) => workerName(`agent-${index}`)));

    expect(names.size).toBeGreaterThan(950);
  });

  test("the name space is the word list times the number range", () => {
    expect(WORKER_NAME_SPACE).toBe(25600);
  });
});
