import { describe, expect, test } from "bun:test";
import { nextPicking, pickGates, readPickKeys } from "./gates-picker";

function terminal(chunks: readonly string[], isTTY = true) {
  const written: string[] = [];
  let listener: ((chunk: string) => void) | null = null;
  const input = {
    isTTY,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    on: (_event: "data", next: (chunk: Buffer | string) => void) => {
      listener = next;
      queueMicrotask(() => {
        for (const chunk of chunks) listener?.(chunk);
      });
    },
    off: () => {
      listener = null;
    },
  };
  return { io: { input, output: { isTTY, write: (chunk: string) => written.push(chunk) } }, written };
}

describe("the gate picker", () => {
  test("reads arrows, space, enter and ctrl-c, carrying an arrow split across reads", () => {
    expect(readPickKeys("\u001b[B \r")).toEqual({ keys: ["down", "toggle", "confirm"], partial: "" });
    expect(readPickKeys("x\u001b[")).toEqual({ keys: ["none"], partial: "\u001b[" });
    expect(readPickKeys("\u001bOA\u0003")).toEqual({ keys: ["up", "abort"], partial: "" });
  });

  test("starts with nothing chosen, toggles the row under the cursor and stops at both ends", () => {
    const start = { index: 0, chosen: new Set<never>() };
    const toggled = nextPicking(start, "toggle");
    expect([...toggled.chosen]).toEqual(["commit-subject"]);
    expect([...nextPicking(toggled, "toggle").chosen]).toEqual([]);
    expect(nextPicking(start, "up").index).toBe(0);
    const bottom = ["down", "down", "down", "down"] as const;
    expect(bottom.reduce(nextPicking, start).index).toBe(2);
  });

  test("returns the gates toggled on, in canonical order, when enter confirms", async () => {
    const { io } = terminal(["\u001b[B", " ", "\u001b[A", " ", "\r"]);
    expect(await pickGates(io)).toEqual(["commit-subject", "check"]);
  });

  test("returns no choice when cancelled", async () => {
    const { io } = terminal([" ", "\u0003"]);
    expect(await pickGates(io)).toBeNull();
  });

  test("asks nothing without a terminal, so an agent is refused rather than prompted", async () => {
    const { io, written } = terminal([" ", "\r"], false);
    expect(await pickGates(io)).toBeNull();
    expect(written).toEqual([]);
  });
});
