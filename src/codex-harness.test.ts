import { describe, expect, test } from "bun:test";
import { isAbsolute, resolve } from "node:path";
import { codexArgs, codexProcess } from "./codex-harness";
import type { HarnessRequest } from "./harness";
import { commandLine, resumeCommandLine } from "./harness-process";

const request: HarnessRequest = {
  cwd: "/repo",
  brief: "build it",
  model: "gpt-5-codex",
  capabilities: [],
  env: { DIM_HOME: "/dim-home" },
};

function parseCodexLine(line: string) {
  return codexProcess.parser()(line);
}

describe("the Codex harness adapter", () => {
  test("maps the Codex lifecycle", () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"t1"}')).toEqual({
      type: "run.started",
      providerSessionId: "t1",
    });
    expect(parseCodexLine('{"type":"turn.started"}')).toEqual({ type: "turn.started" });
    expect(parseCodexLine('{"type":"turn.completed"}')).toEqual({ type: "run.completed" });
  });

  test("answers a run with its last agent message, which carries structured output when a schema was given", () => {
    const parse = codexProcess.parser();
    const events = [
      '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"I am checking the repository."}}',
      '{"type":"item.completed","item":{"id":"m2","type":"agent_message","text":"{\\"body\\":\\"done\\"}"}}',
      '{"type":"turn.completed"}',
    ].flatMap((line) => parse(line) ?? []);

    expect(events.at(-1)).toEqual({ type: "run.completed", output: '{"body":"done"}' });
  });

  test("maps assistant messages and command completion", () => {
    expect(
      parseCodexLine('{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"done"}}'),
    ).toEqual({ type: "message", role: "assistant", text: "done" });
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"c1","type":"command_execution","aggregated_output":"ok","exit_code":0}}',
      ),
    ).toEqual([
      { type: "tool.output", name: "command_execution", text: "ok", toolId: "c1" },
      { type: "tool.completed", name: "command_execution", exitCode: 0, toolId: "c1" },
    ]);
  });

  test("turns provider failures and malformed output into visible failures", () => {
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"no"}}')).toEqual({
      type: "run.failed",
      reason: "no",
    });
    expect(parseCodexLine("not json")).toEqual({
      type: "diagnostic",
      level: "error",
      message: "Codex emitted invalid JSON",
    });
  });

  test("builds a writable Codex command for builders and a read-only one otherwise", () => {
    const writable = commandLine(codexProcess, { ...request, capabilities: ["edit-files"] });
    const readOnly = commandLine(codexProcess, request);

    expect(writable).toEqual([
      "codex",
      "-c",
      'forced_login_method="chatgpt"',
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
  });

  test("passes a response schema to Codex when a station requests one", () => {
    const argv = codexArgs({ ...request, outputSchema: "/dim-home/plan.json" });

    expect(argv).toContain("--output-schema");
    expect(argv).toContain("/dim-home/plan.json");
  });

  test("grants builders access to the repository metadata", () => {
    const argv = codexArgs({ ...request, cwd: process.cwd(), capabilities: ["edit-files"] });
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

  test("keeps every per-token API key out of a worker", () => {
    expect(
      codexProcess.environment?.({
        PATH: "/bin",
        DIM_WORKER_TOKEN: "worker-token",
        CODEX_API_KEY: "codex-key",
        OPENAI_API_KEY: "openai-key",
      }),
    ).toEqual({ PATH: "/bin", DIM_WORKER_TOKEN: "worker-token" });
  });

  test("resumes a Codex session by its provider id", () => {
    expect(resumeCommandLine(codexProcess, "thread-1", request)).toEqual([
      "codex",
      "-c",
      'forced_login_method="chatgpt"',
      "-s",
      "read-only",
      "--add-dir",
      "/dim-home",
      "exec",
      "resume",
      "--json",
      "thread-1",
      "-m",
      "gpt-5-codex",
      "build it",
    ]);
  });

  test("keeps builder metadata writable when a Codex session resumes", () => {
    const argv = resumeCommandLine(codexProcess, "thread-1", {
      ...request,
      cwd: process.cwd(),
      capabilities: ["edit-files"],
    });
    const gitMetadata = Bun.spawnSync(
      ["git", "-C", process.cwd(), "rev-parse", "--git-dir", "--git-common-dir"],
      { stdout: "pipe", stderr: "ignore" },
    )
      .stdout.toString()
      .trim()
      .split("\n");
    const expectedMetadata = [...new Set(gitMetadata)]
      .filter((gitDir) => gitDir.length > 0)
      .map((gitDir) => (isAbsolute(gitDir) ? gitDir : resolve(process.cwd(), gitDir)));
    const addDirs = argv.flatMap((arg, index) => (arg === "--add-dir" ? [argv[index + 1]] : []));

    expect(argv.slice(0, 5)).toEqual([
      "codex",
      "-c",
      'forced_login_method="chatgpt"',
      "-s",
      "workspace-write",
    ]);
    expect(addDirs).toEqual(["/dim-home", ...expectedMetadata]);
  });
});
