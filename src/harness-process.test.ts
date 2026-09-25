import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, HarnessEvent, HarnessRequest } from "./harness";
import { processHarness } from "./harness-process";
import { type HarnessRunnerOptions, runHarness } from "./harness-runner";

const request = { cwd: process.cwd(), brief: "run", model: "test", capabilities: [], env: {} } as const;

const inherited = (started: HarnessRequest) => ({ ...process.env, ...started.env });

async function runStarted(adapter: HarnessAdapter, started: HarnessRequest, options: HarnessRunnerOptions) {
  return runHarness(await adapter.start(started), options);
}

function command(script: string) {
  return processHarness(
    {
      command: process.execPath,
      args: () => ["-e", script],
      resumeArgs: () => ["-e", script],
      parser: () => (line) => JSON.parse(line) as HarnessEvent,
    },
    inherited,
  );
}

describe("the external process harness", () => {
  test("streams normalized events and observes a clean exit", async () => {
    const result = await runStarted(
      command(
        `console.log(JSON.stringify({type:"run.started",providerSessionId:"fixture"})); console.log(JSON.stringify({type:"run.completed",output:"done"}));`,
      ),
      request,
      { timeoutMs: 1000 },
    );

    expect(result).toMatchObject({
      outcome: "completed",
      events: expect.arrayContaining([{ type: "run.completed", output: "done" }]),
    });
  });

  test("delivers startup output while the process is still running", async () => {
    let resolveStarted!: () => void;
    let finished = false;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const result = runStarted(
      command(
        `console.log(JSON.stringify({type:"run.started",providerSessionId:"fixture"})); setTimeout(()=>console.log(JSON.stringify({type:"run.completed",output:"done"})),300);`,
      ),
      request,
      {
        timeoutMs: 1000,
        onEvent(event) {
          if (event.type === "run.started") resolveStarted();
        },
      },
    ).finally(() => {
      finished = true;
    });

    await started;
    expect(finished).toBe(false);
    await expect(result).resolves.toMatchObject({
      outcome: "completed",
      events: expect.arrayContaining([{ type: "run.completed", output: "done" }]),
    });
  });

  test("delivers terminal output written before an immediate process exit", async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const script = `require("node:fs").writeSync(1,JSON.stringify({type:"run.completed",output:"done"})+"\\n"); process.exit(0);`;
      const result = await runStarted(command(script), request, { timeoutMs: 100 });
      expect(result).toMatchObject({
        outcome: "completed",
        events: expect.arrayContaining([{ type: "run.completed", output: "done" }]),
      });
    }
  });

  test("turns an unannounced nonzero exit into a structured failure", async () => {
    const result = await runStarted(command("process.exit(7)"), request, { timeoutMs: 1000 });

    expect(result).toMatchObject({
      outcome: "failed",
      reason: "harness exited with code 7",
      exitCode: 7,
      termination: "exited",
    });
  });

  test("records stderr when a process exits without a terminal event", async () => {
    const result = await runStarted(
      command('console.error("codex stream closed"); process.exit(0)'),
      request,
      { timeoutMs: 1000 },
    );

    expect(result).toMatchObject({
      outcome: "failed",
      reason: "harness exited without a terminal event",
      exitCode: 0,
      stderr: "codex stream closed",
      termination: "exited",
    });
  });

  test("observes a process exit while a descendant keeps stdout open", async () => {
    const result = await runStarted(
      command(
        `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setTimeout(()=>{},500)"],{stdio:["ignore","inherit","inherit"]}); child.unref(); process.stderr.write(String(child.pid)); process.exit(0);`,
      ),
      request,
      { timeoutMs: 100 },
    );

    const pid = Number(result.outcome === "failed" ? result.stderr : undefined);
    try {
      expect(result).toMatchObject({
        outcome: "failed",
        reason: "harness exited without a terminal event",
        exitCode: 0,
        termination: "exited",
      });
    } finally {
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
    }
  });

  test("cancels a process that does not produce a terminal event", async () => {
    const result = await runStarted(command("setInterval(() => {}, 1000)"), request, { timeoutMs: 10 });

    expect(result).toMatchObject({ outcome: "timed_out", reason: "harness timed out" });
  });

  test("stops a process that reports a failure and keeps running", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "dim-harness-marker-")), "still-running");
    const result = await runStarted(
      command(
        `console.log(JSON.stringify({type:"run.failed",reason:"refused"})); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 300);`,
      ),
      request,
      { timeoutMs: 5000 },
    );
    await Bun.sleep(600);

    expect(result).toMatchObject({ outcome: "failed", reason: "refused" });
    expect(existsSync(marker)).toBe(false);
  });

  test("leaves a completed process to finish, since its harness records the session after the answer", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "dim-harness-marker-")), "recorded");
    await runStarted(
      command(
        `console.log(JSON.stringify({type:"run.completed",output:"done"})); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 300);`,
      ),
      request,
      { timeoutMs: 5000 },
    );
    await Bun.sleep(600);

    expect(existsSync(marker)).toBe(true);
  });

  test("gives each run a parser of its own", async () => {
    let parsers = 0;
    const script = `console.log(JSON.stringify({type:"turn.started"})); console.log(JSON.stringify({type:"run.completed",output:"done"}));`;
    const adapter = processHarness(
      {
        command: process.execPath,
        args: () => ["-e", script],
        resumeArgs: () => ["-e", script],
        parser: () => {
          parsers += 1;
          return (line) => JSON.parse(line) as HarnessEvent;
        },
      },
      inherited,
    );

    await runStarted(adapter, request, { timeoutMs: 1000 });
    await runStarted(adapter, request, { timeoutMs: 1000 });

    expect(parsers).toBe(2);
  });

  test("removes capture files when the process cannot start", async () => {
    const before = readdirSync(tmpdir())
      .filter((entry) => entry.startsWith("dim-harness-"))
      .sort();
    const adapter = processHarness(
      {
        command: "/missing/dim-harness-command",
        args: () => [],
        resumeArgs: () => [],
        parser: () => () => undefined,
      },
      inherited,
    );

    await expect(adapter.start(request)).rejects.toThrow();

    const after = readdirSync(tmpdir())
      .filter((entry) => entry.startsWith("dim-harness-"))
      .sort();
    expect(after).toEqual(before);
  });
});
