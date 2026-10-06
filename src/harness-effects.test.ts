import { expect, test } from "bun:test";
import { spawnHarness } from "./harness-effects";
import type { Trace } from "./trace-contract";

const trace: Trace = {
  step: (_name, _start, perform, ..._result) => perform(),
  stepAsync: (_name, _start, perform, ..._result) => perform(),
};

test("hears each line the harness prints while it is still running, and keeps them all for its end", async () => {
  const heardAt = new Map<string, number>();
  const spawned = spawnHarness(trace, {
    argv: ["sh", "-c", "echo one; sleep 0.5; printf 'two\\nthree'"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    session: "s",
    heard: (line) => heardAt.set(line, performance.now()),
  });
  spawned.prompt("");
  const ended = await spawned.ended;
  const endedAt = performance.now();
  expect(endedAt - (heardAt.get("one") ?? endedAt)).toBeGreaterThan(300);
  expect([...heardAt.keys()]).toEqual(["one", "two", "three"]);
  expect(ended.lines).toEqual(["one", "two", "three"]);
});
