import { describe, expect, test } from "bun:test";
import { isAbsolute, resolve } from "node:path";
import { codexArgv, codexHarness, codexResumeArgv, parseCodexHarnessEvent } from "./codex-harness";
import type { HarnessRequest } from "./harness";

const request: HarnessRequest = {
  cwd: "/repo",
  brief: "build it",
  model: "gpt-5-codex",
  capabilities: [],
  env: { DIM_HOME: "/dim-home" },
};

describe("the Codex harness adapter", () => {
  test("maps the Codex lifecycle", () => {
    expect(parseCodexHarnessEvent('{"type":"thread.started","thread_id":"t1"}')).toEqual({
      type: "run.started",
      providerSessionId: "t1",
    });
    expect(parseCodexHarnessEvent('{"type":"turn.started"}')).toEqual({ type: "turn.started" });
    expect(parseCodexHarnessEvent('{"type":"turn.completed"}')).toEqual({ type: "run.completed" });
  });

  test("maps assistant messages and command completion", () => {
    expect(
      parseCodexHarnessEvent(
        '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"done"}}',
      ),
    ).toEqual({ type: "message", role: "assistant", text: "done" });
    expect(
      parseCodexHarnessEvent(
        '{"type":"item.completed","item":{"id":"c1","type":"command_execution","aggregated_output":"ok","exit_code":0}}',
      ),
    ).toEqual([
      { type: "tool.output", name: "command_execution", text: "ok", toolId: "c1" },
      { type: "tool.completed", name: "command_execution", exitCode: 0, toolId: "c1" },
    ]);
  });

  test("turns provider failures and malformed output into visible failures", () => {
    expect(parseCodexHarnessEvent('{"type":"turn.failed","error":{"message":"no"}}')).toEqual({
      type: "run.failed",
      reason: "no",
    });
    expect(parseCodexHarnessEvent("not json")).toEqual({
      type: "diagnostic",
      level: "error",
      message: "Codex emitted invalid JSON",
    });
  });

  test("builds a writable Codex command for builders and a read-only one otherwise", () => {
    const writable = codexArgv("codex-test", { ...request, capabilities: ["edit-files"] });
    const readOnly = codexArgv("codex-test", request);

    expect(writable).toEqual([
      "codex-test",
      "exec",
      "--json",
      "-s",
      "workspace-write",
      "--add-dir",
      "/dim-home",
      "-C",
      "/repo",
      "-m",
      "gpt-5-codex",
      "build it",
    ]);
    expect(readOnly).toContain("read-only");
    expect(codexHarness("codex-test").name).toBe("codex");
  });

  test("passes a response schema to Codex when a station requests one", () => {
    const argv = codexArgv("codex-test", { ...request, outputSchema: "/dim-home/plan.json" });

    expect(argv).toContain("--output-schema");
    expect(argv).toContain("/dim-home/plan.json");
  });

  test("grants builders access to the repository metadata", () => {
    const argv = codexArgv("codex-test", { ...request, cwd: process.cwd(), capabilities: ["edit-files"] });
    const gitMetadata = Bun.spawnSync(
      ["git", "-C", process.cwd(), "rev-parse", "--git-dir", "--git-common-dir"],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    )
      .stdout.toString()
      .trim()
      .split("\n");
    const expectedMetadata = [...new Set(gitMetadata)]
      .filter((gitDir) => gitDir.length > 0)
      .map((gitDir) => (isAbsolute(gitDir) ? gitDir : resolve(process.cwd(), gitDir)));
    const addDirs = argv.flatMap((arg, index) => (arg === "--add-dir" ? [argv[index + 1]] : []));

    expect(argv).toContain("workspace-write");
    expect(addDirs[0]).toBe("/dim-home");
    expect(addDirs.slice(1)).toEqual(expectedMetadata);
  });

  test("resumes a Codex session by its provider id", () => {
    expect(codexResumeArgv("codex-test", "thread-1", request)).toEqual([
      "codex-test",
      "exec",
      "resume",
      "--json",
      "thread-1",
      "-m",
      "gpt-5-codex",
      "build it",
    ]);
  });
});
