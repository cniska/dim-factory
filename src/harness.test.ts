import { describe, expect, test } from "bun:test";
import { fakeHarness } from "./fake-harness";
import { runHarness } from "./harness-runner";

const REQUEST = {
  cwd: "/tmp/project",
  brief: "build it",
  model: "test",
  capabilities: ["read-files"] as const,
  env: { DIM_WORKER_NAME: "fake-worker" },
};

async function events(name: Parameters<typeof fakeHarness>[0]): Promise<unknown[]> {
  const run = await fakeHarness(name).start(REQUEST);
  const seen: unknown[] = [];
  for await (const event of run.events) {
    seen.push(event);
    if (event.type === "run.completed" || event.type === "run.failed") break;
  }
  return seen;
}

describe("the fake harness", () => {
  test("models a successful session", async () => {
    await expect(events("success")).resolves.toEqual([
      { type: "run.started", providerSessionId: "fake-session" },
      { type: "turn.started" },
      { type: "message", role: "assistant", text: "completed" },
      { type: "run.completed", output: "completed" },
    ]);
  });

  test("models a completed review that contains findings", async () => {
    await expect(events("findings")).resolves.toContainEqual({
      type: "message",
      role: "assistant",
      text: "finding: the result needs another pass",
    });
  });

  test("models a crash and a bootstrap failure as distinct failures", async () => {
    await expect(events("crash")).resolves.toContainEqual({
      type: "run.failed",
      reason: "fake process crashed",
    });
    await expect(events("bootstrap-failure")).resolves.toContainEqual({
      type: "run.failed",
      reason: "worker bootstrap failed",
    });
  });

  test("keeps a hung session open until the runner cancels it", async () => {
    const run = await fakeHarness("hang").start(REQUEST);
    const iterator = run.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "run.started", providerSessionId: "fake-session" },
    });
    run.cancel();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("returns a timeout when a harness produces no terminal event", async () => {
    const seen: string[] = [];
    const result = await runHarness(await fakeHarness("hang").start(REQUEST), {
      timeoutMs: 1,
      onEvent: (event) => seen.push(event.type),
    });

    expect(result).toMatchObject({ outcome: "timed_out", reason: "harness timed out" });
    expect(seen).toEqual(["run.started", "turn.started"]);
  });

  test("returns terminal output and forwards every event", async () => {
    const seen: string[] = [];
    const result = await runHarness(await fakeHarness("success").start(REQUEST), {
      timeoutMs: 100,
      onEvent: (event) => seen.push(event.type),
    });

    expect(result).toMatchObject({
      outcome: "completed",
      events: expect.arrayContaining([{ type: "run.completed", output: "completed" }]),
    });
    expect(seen).toEqual(["run.started", "turn.started", "message", "run.completed"]);
  });
});
