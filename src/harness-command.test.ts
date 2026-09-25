import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHarness } from "./fake-harness";
import type { HarnessAdapter, HarnessEvent } from "./harness";
import {
  harnessArgv,
  runHarnessCommand,
  runHarnessCommandLive,
  runHarnessCommandResumeLive,
  workerFailureReason,
} from "./harness-command";

describe("selected harness commands", () => {
  test("gives a read-only planning request to Codex", () => {
    expect(
      harnessArgv({
        harness: "codex",
        cwd: "/worktree",
        brief: "plan the order",
        model: "deep-model",
        capabilities: ["read-files"],
        env: { DIM_HOME: "/dim-home" },
      }),
    ).toEqual([
      "codex",
      "-c",
      'forced_login_method="chatgpt"',
      "exec",
      "--json",
      "-s",
      "read-only",
      "--add-dir",
      "/dim-home",
      "-C",
      "/worktree",
      "-m",
      "deep-model",
      "plan the order",
    ]);
  });

  test("gives an editing request workspace write access", () => {
    expect(
      harnessArgv({
        harness: "codex",
        cwd: "/worktree",
        brief: "build the order",
        model: "standard-model",
        capabilities: ["edit-files"],
        env: {},
      }),
    ).toContain("workspace-write");
  });

  test("runs a deterministic adapter through the live command boundary", async () => {
    const result = await runHarnessCommandLive(
      {
        harness: "codex",
        cwd: "/worktree",
        brief: "run the fake worker",
        model: "standard-model",
        capabilities: ["read-files"],
        env: {},
      },
      () => undefined,
      fakeHarness("crash"),
    );

    expect(result).toMatchObject({ exitCode: 1, failureReason: "fake process crashed", output: "" });
  });

  test("carries process termination evidence into the worker failure", async () => {
    const adapter: HarnessAdapter = {
      start: async () => ({
        events: (async function* () {
          yield {
            type: "run.failed",
            reason: "harness exited without a terminal event",
            exitCode: 0,
            stderr: "codex stream closed",
            termination: "exited",
          } as const;
        })(),
        cancel() {},
      }),
      resume: async () => {
        throw new Error("not used");
      },
    };

    const result = await runHarnessCommandLive(
      {
        harness: "codex",
        cwd: "/worktree",
        brief: "run the worker",
        model: "standard-model",
        capabilities: ["read-files"],
        env: {},
      },
      () => undefined,
      adapter,
    );

    expect(result).toMatchObject({
      exitCode: 1,
      harnessExitCode: 0,
      failureReason: "harness exited without a terminal event; stderr: codex stream closed",
      stderr: "codex stream closed",
      termination: "exited",
    });
  });

  test("keeps the worker's last word on a failed run, and takes a completed run's answer only from its completion", async () => {
    const scripted = (events: HarnessEvent[]): HarnessAdapter => ({
      start: async () => ({
        events: (async function* () {
          yield* events;
        })(),
        cancel() {},
      }),
      resume: async () => {
        throw new Error("not used");
      },
    });
    const request = {
      harness: "codex",
      cwd: "/worktree",
      brief: "run the worker",
      model: "standard-model",
      capabilities: ["read-files"],
      env: {},
    } as const;
    const said = {
      type: "message",
      role: "assistant",
      text: "tests fail because the fixture is missing",
    } as const;

    const failed = await runHarnessCommandLive(
      request,
      () => undefined,
      scripted([said, { type: "run.failed", reason: "turn failed" }]),
    );
    const completed = await runHarnessCommandLive(
      request,
      () => undefined,
      scripted([said, { type: "run.completed" }]),
    );

    expect(failed).toMatchObject({ exitCode: 1, output: "tests fail because the fixture is missing" });
    expect(workerFailureReason("builder did not finish", failed.output, failed.failureReason)).toBe(
      "builder did not finish: turn failed; its last message: tests fail because the fixture is missing",
    );
    expect(completed).toMatchObject({ exitCode: 0, output: "" });
  });

  test("says a run that ran out of time timed out", async () => {
    const result = await runHarnessCommandLive(
      {
        harness: "codex",
        cwd: "/worktree",
        brief: "run the fake worker",
        model: "standard-model",
        capabilities: ["read-files"],
        env: {},
      },
      () => undefined,
      fakeHarness("hang"),
      { timeoutMs: 20 },
    );

    expect(result).toMatchObject({
      exitCode: 1,
      failureReason: "harness went 0.02s without an event and was stopped",
    });
    expect(result.harnessExitCode).toBeUndefined();
  });

  test("resumes a deterministic adapter through the live command boundary", async () => {
    const result = await runHarnessCommandResumeLive(
      {
        harness: "codex",
        cwd: "/worktree",
        brief: "continue the work",
        model: "standard-model",
        capabilities: ["read-files"],
        env: {},
      },
      "fake-session",
      () => undefined,
      fakeHarness("success"),
    );

    expect(result).toMatchObject({ exitCode: 0, output: "completed" });
  });

  test("returns the answer a harness reports on completion over its last message", async () => {
    const adapter: HarnessAdapter = {
      start: async () => ({
        events: (async function* () {
          yield { type: "run.started", providerSessionId: "session" } as const;
          yield { type: "message", role: "assistant", text: "ok" } as const;
          yield { type: "run.completed", output: '{"body":"done"}' } as const;
        })(),
        cancel() {},
      }),
      resume: async () => {
        throw new Error("not used");
      },
    };

    const result = await runHarnessCommandLive(
      {
        harness: "claude",
        cwd: "/worktree",
        brief: "plan the order",
        model: "deep-model",
        capabilities: ["read-files"],
        env: {},
      },
      () => undefined,
      adapter,
    );

    expect(result.output).toBe('{"body":"done"}');
  });

  test("gives a Claude request to the claude command", () => {
    const argv = harnessArgv({
      harness: "claude",
      cwd: "/worktree",
      brief: "build the order",
      model: "standard-model",
      capabilities: ["edit-files"],
      env: { DIM_HOME: "/dim-home" },
    });

    expect(argv.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(argv.slice(-2)).toEqual(["--", "build the order"]);
  });
});

describe("a harness run with no adapter given", () => {
  // A stand-in for the claude CLI: it answers in Claude's stream-json, naming whether it was resumed.
  const bin = mkdtempSync(join(tmpdir(), "dim-claude-bin-"));
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
case " $* " in *" --resume s1 "*) answer='{"body":"resumed"}' ;; *) answer='{"body":"started"}' ;; esac
echo '{"type":"system","subtype":"init","session_id":"s1"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}'
printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":$(printf '%s' "$answer" | sed 's/"/\\\\"/g; s/^/"/; s/$/"/')}"
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  afterAll(() => rmSync(bin, { recursive: true, force: true }));
  const request = {
    harness: "claude",
    cwd: bin,
    brief: "plan the order",
    model: "deep-model",
    capabilities: ["read-files"],
    env: { DIM_HOME: bin, PATH: `${bin}:${process.env.PATH ?? ""}` },
  } as const;

  test("runs the harness the request names", async () => {
    const started: string[] = [];
    const result = await runHarnessCommandLive(request, (session) => started.push(session));

    expect(result).toMatchObject({ exitCode: 0, output: '{"body":"started"}' });
    expect(started).toEqual(["s1"]);
  });

  test("resumes through the harness the request names", async () => {
    const result = await runHarnessCommandResumeLive(request, "s1", () => undefined);

    expect(result).toMatchObject({ exitCode: 0, output: '{"body":"resumed"}' });
  });

  test("starts a worker of either harness with only the identity its request gives it, on both paths", async () => {
    const reporting = mkdtempSync(join(tmpdir(), "dim-harness-bin-"));
    const seen = [
      "DIM_WORKER_NAME",
      "DIM_WORKER_TOKEN",
      "DIM_SESSION_ID",
      "DIM_WORKER_ASSIGNMENT_ID",
      "DIM_WORKER_ASSIGNMENT_TOKEN",
      "CLAUDECODE",
      "CLAUDE_PID",
      "CLAUDE_EFFORT",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "CODEX_THREAD_ID",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]
      .map((name) => `\${${name}:-}`)
      .join("|");
    writeFileSync(
      join(reporting, "claude"),
      `#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"s1"}'
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"${seen}\\"}"
`,
    );
    writeFileSync(
      join(reporting, "codex"),
      `#!/bin/sh
echo '{"type":"thread.started","thread_id":"t1"}'
echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"${seen}\\"}}"
echo '{"type":"turn.completed"}'
`,
    );
    chmodSync(join(reporting, "claude"), 0o755);
    chmodSync(join(reporting, "codex"), 0o755);
    const operator = {
      DIM_WORKER_NAME: "operator-1",
      DIM_WORKER_TOKEN: "operator-token",
      DIM_SESSION_ID: "operator-dim-session",
      DIM_WORKER_ASSIGNMENT_TOKEN: "stale-assignment-token",
      CLAUDECODE: "1",
      CLAUDE_PID: "4242",
      CLAUDE_EFFORT: "high",
      CLAUDE_CODE_SESSION_ID: "operator-session",
      CLAUDE_CODE_MESSAGING_TOKEN: "operator-messaging-token",
      CODEX_THREAD_ID: "operator-thread",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      ANTHROPIC_API_KEY: "sk-ant",
    };
    const saved = Object.fromEntries(Object.keys(operator).map((name) => [name, process.env[name]]));
    Object.assign(process.env, operator);
    try {
      for (const harness of ["claude", "codex"] as const) {
        const assigned = {
          ...request,
          harness,
          env: {
            ...request.env,
            PATH: `${reporting}:${process.env.PATH ?? ""}`,
            DIM_WORKER_ASSIGNMENT_ID: "assignment-1",
            DIM_WORKER_ASSIGNMENT_TOKEN: "assignment-token",
          },
        };
        const expected = `|||assignment-1|assignment-token|||||||subscription|${harness === "codex" ? "sk-ant" : ""}`;

        expect((await runHarnessCommandLive(assigned, () => undefined)).output).toBe(expected);
        expect(runHarnessCommand(assigned).output).toBe(expected);
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(reporting, { recursive: true, force: true });
    }
  });

  test("fails a synchronous run whose stream reports a failure, whatever the process exits with", () => {
    const failing = mkdtempSync(join(tmpdir(), "dim-claude-bin-"));
    writeFileSync(
      join(failing, "claude"),
      `#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"s1"}'
echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in"}'
exit 0
`,
    );
    chmodSync(join(failing, "claude"), 0o755);

    const result = runHarnessCommand({
      ...request,
      env: { ...request.env, PATH: `${failing}:${process.env.PATH ?? ""}` },
    });
    rmSync(failing, { recursive: true, force: true });

    expect(result).toMatchObject({ exitCode: 1, failureReason: "Not logged in" });
  });

  test("reads the named harness's stream on the synchronous path", () => {
    const result = runHarnessCommand(request);

    expect(result.output).toBe('{"body":"started"}');
    expect(result.events).toContainEqual({ type: "run.started", providerSessionId: "s1" });
  });
});
