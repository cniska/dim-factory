import { describe, expect, test } from "bun:test";
import { fakeHarness } from "./fake-harness";
import { harnessArgv, runHarnessCommandLive } from "./harness-command";

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
      "--ephemeral",
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
});
