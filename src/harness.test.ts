import { describe, expect, test } from "bun:test";
import type { HarnessEvent } from "./harness";
import { fakeHarness } from "./harness-fake";
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

  test("lets a harness that keeps emitting events run past the timeout", async () => {
    async function* working(): AsyncIterable<HarnessEvent> {
      for (let step = 0; step < 6; step++) {
        await Bun.sleep(20);
        yield { type: "tool.completed", name: "Bash" };
      }
      yield { type: "run.completed", output: "done" };
    }

    const result = await runHarness(
      { pid: process.pid, events: working(), cancel: () => undefined },
      { timeoutMs: 60 },
    );

    expect(result).toMatchObject({ outcome: "completed" });
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

  test("keeps the first answer and stops a worker that begins another turn after it", async () => {
    const harness = fakeHarness("turn-after-answer");
    const seen: string[] = [];
    const result = await runHarness(await harness.start(REQUEST), {
      timeoutMs: 60_000,
      onEvent: (event) => seen.push(event.type),
    });

    expect(result).toMatchObject({
      outcome: "completed",
      events: expect.arrayContaining([
        { type: "run.completed", output: "completed" },
        {
          type: "diagnostic",
          level: "warning",
          message: "stopped the worker after its answer: it began another turn (run.started)",
        },
      ]),
    });
    expect(seen).toEqual(["run.started", "turn.started", "run.completed"]);
    expect(harness.cancels()).toBe(1);
  });

  test("fails a run that starts twice before answering as a harness fault", async () => {
    const harness = fakeHarness("second-start");
    const seen: string[] = [];
    const result = await runHarness(await harness.start(REQUEST), {
      timeoutMs: 60_000,
      onEvent: (event) => seen.push(event.type),
    });

    expect(result).toMatchObject({
      outcome: "failed",
      reason: "harness fault: the worker started a second run before answering",
    });
    expect(seen).toEqual(["run.started", "turn.started"]);
    expect(harness.cancels()).toBeGreaterThan(0);
  });

  test("stops the worker when observing one of its events throws", async () => {
    const harness = fakeHarness("hang");

    await expect(
      runHarness(await harness.start(REQUEST), {
        timeoutMs: 60_000,
        onEvent: () => {
          throw new Error("could not record the start");
        },
      }),
    ).rejects.toThrow("could not record the start");

    expect(harness.cancels()).toBe(1);
  });

  test("returns the answer, not a timeout, when a worker that answered goes silent without exiting", async () => {
    async function* answeredThenSilent(): AsyncIterable<HarnessEvent> {
      yield { type: "run.completed", output: "done" };
      await new Promise(() => undefined);
    }
    let cancelled = false;

    const result = await runHarness(
      {
        pid: process.pid,
        events: answeredThenSilent(),
        cancel: () => {
          cancelled = true;
        },
      },
      { timeoutMs: 10 },
    );

    expect(result).toMatchObject({
      outcome: "completed",
      events: [
        { type: "run.completed", output: "done" },
        {
          type: "diagnostic",
          level: "warning",
          message: "stopped the worker after its answer: it went 0.01s without an event and did not exit",
        },
      ],
    });
    expect(cancelled).toBe(true);
  });
});
