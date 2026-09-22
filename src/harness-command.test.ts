import { describe, expect, test } from "bun:test";
import { harnessArgv } from "./harness-command";

describe("selected harness commands", () => {
  test("gives a read-only planning request to Codex", () => {
    expect(
      harnessArgv({
        harness: "codex",
        cwd: "/worktree",
        brief: "plan the order",
        model: "deep-model",
        capabilities: ["read-files"],
        env: {},
      }),
    ).toEqual([
      "codex",
      "exec",
      "--json",
      "--ephemeral",
      "-s",
      "read-only",
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
});
