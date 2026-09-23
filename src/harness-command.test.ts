import { describe, expect, test } from "bun:test";
import { fakeHarness } from "./fake-harness";
import type { HarnessAdapter } from "./harness";
import { harnessArgv, runHarnessCommandLive, runHarnessCommandResumeLive } from "./harness-command";

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

  test("returns the final assistant message when the harness emits progress first", async () => {
    const adapter: HarnessAdapter = {
      name: "progress-then-result",
      start: async () => ({
        events: (async function* () {
          yield { type: "run.started", providerSessionId: "session" } as const;
          yield { type: "message", role: "assistant", text: "I am checking the repository." } as const;
          yield {
            type: "message",
            role: "assistant",
            text: '{"body":"done","slices":[{"title":"one","outcome":"ok"}]}',
          } as const;
          yield { type: "run.completed" } as const;
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
        brief: "plan the order",
        model: "deep-model",
        capabilities: ["read-files"],
        env: {},
      },
      () => undefined,
      adapter,
    );

    expect(result.output).toBe('{"body":"done","slices":[{"title":"one","outcome":"ok"}]}');
  });
});
