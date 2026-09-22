import { describe, expect, test } from "bun:test";
import type { HarnessEvent } from "./harness";
import { processHarness } from "./harness-process";
import { runHarness } from "./harness-runner";

const request = { cwd: process.cwd(), brief: "run", model: "test", capabilities: [], env: {} } as const;

function command(script: string) {
  return processHarness({
    name: "fixture",
    argv: () => [process.execPath, "-e", script],
    resumeArgv: () => [process.execPath, "-e", script],
    parse: (line) => JSON.parse(line) as HarnessEvent,
  });
}

describe("the external process harness", () => {
  test("streams normalized events and observes a clean exit", async () => {
    const result = await runHarness(
      command(
        `console.log(JSON.stringify({type:"run.started",providerSessionId:"fixture"})); console.log(JSON.stringify({type:"run.completed",output:"done"}));`,
      ),
      request,
      { timeoutMs: 1000 },
    );

    expect(result).toMatchObject({ outcome: "completed", output: "done" });
  });

  test("turns an unannounced nonzero exit into a structured failure", async () => {
    const result = await runHarness(command("process.exit(7)"), request, { timeoutMs: 1000 });

    expect(result).toMatchObject({ outcome: "failed", reason: "harness exited with code 7" });
  });

  test("cancels a process that does not produce a terminal event", async () => {
    const result = await runHarness(command("setInterval(() => {}, 1000)"), request, { timeoutMs: 10 });

    expect(result).toMatchObject({ outcome: "timed_out", reason: "harness timed out" });
  });
});
