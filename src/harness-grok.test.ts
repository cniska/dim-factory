import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRequest } from "./harness";
import { grokArgs, grokProcess } from "./harness-grok";
import { commandLine, resumeCommandLine } from "./harness-process";

const request: HarnessRequest = {
  cwd: "/repo",
  brief: "build it",
  model: "grok-model",
  capabilities: [],
  env: { DIM_HOME: "/dim-home" },
};

function parseAll(lines: unknown[]) {
  const parse = grokProcess.parser();
  return lines.flatMap((line) => {
    const parsed = parse(typeof line === "string" ? line : JSON.stringify(line));
    return parsed === undefined ? [] : Array.isArray(parsed) ? parsed : [parsed];
  });
}

function denies(argv: string[]): string[] {
  return argv.flatMap((arg, index) => (argv[index - 1] === "--deny" ? [arg] : []));
}

describe("the Grok harness adapter", () => {
  test("starts a subscription session and refuses per-token billing", () => {
    expect(parseAll([{ type: "system", subtype: "init", session_id: "s1", apiKeySource: "oauth" }])).toEqual([
      { type: "run.started", providerSessionId: "s1" },
      { type: "turn.started" },
    ]);
    expect(parseAll([{ type: "system", subtype: "init", session_id: "s1", apiKeySource: "user" }])).toEqual([
      {
        type: "run.failed",
        reason:
          "Grok would bill this worker per token through an API key; sign in with a subscription instead",
      },
    ]);
    expect(parseAll([{ type: "system", subtype: "init", session_id: "s1" }])).toEqual([
      {
        type: "run.failed",
        reason: "Grok did not report its API key source; cannot verify billing for this worker",
      },
    ]);
    expect(parseAll([{ type: "system", subtype: "init", apiKeySource: "oauth" }])).toEqual([
      { type: "run.failed", reason: "Grok did not report a session id" },
    ]);
  });

  test("maps assistant text and a tool call, and drops thinking", () => {
    expect(
      parseAll([
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "secret" },
              { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
            ],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hi", is_error: false }] },
        },
        { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      ]),
    ).toEqual([
      { type: "tool.started", name: "read_file", toolId: "t1" },
      { type: "tool.output", name: "read_file", text: "hi", toolId: "t1" },
      { type: "tool.completed", name: "read_file", toolId: "t1" },
      { type: "message", role: "assistant", text: "ok" },
    ]);
  });

  test("completes with structured output when a schema was given", () => {
    expect(
      parseAll([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Done.",
          structured_output: { answer: "ok" },
        },
        { type: "result", subtype: "success", is_error: false, result: "Done." },
        { type: "error", message: "Couldn't start session" },
      ]),
    ).toEqual([
      { type: "run.completed", output: '{"answer":"ok"}' },
      { type: "run.completed", output: "Done." },
      { type: "run.failed", reason: "Couldn't start session" },
    ]);
  });

  test("fails with the provider's own message from a failed result's errors", () => {
    expect(
      parseAll([
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [
            'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}',
          ],
        },
        { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Session aborted"] },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ['Internal error: {"message": "first"}', "second"],
        },
        { type: "result", subtype: "error_during_execution", is_error: true },
      ]),
    ).toEqual([
      {
        type: "run.failed",
        reason: "API error (status 402 Payment Required): Grok Build usage balance exhausted",
        usageLimit: {},
      },
      { type: "run.failed", reason: "Session aborted" },
      { type: "run.failed", reason: "first; second" },
      { type: "run.failed", reason: "error_during_execution" },
    ]);
  });

  test("runs builders in the workspace sandbox and readers in the read-only sandbox", () => {
    const builder = commandLine(grokProcess, { ...request, capabilities: ["edit-files"] });
    const reader = commandLine(grokProcess, request);

    expect(builder.slice(0, 8)).toEqual([
      "grok",
      "--no-auto-update",
      "--output-format",
      "streaming-messages-json",
      "--permission-mode",
      "bypassPermissions",
      "--sandbox",
      "workspace",
    ]);
    expect(reader[reader.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(denies(reader)).toEqual(["Edit", "Write"]);
    expect(builder.slice(-4)).toEqual(["--model", "grok-model", "-p", "build it"]);
  });

  test("denies a builder the checkout's git metadata", () => {
    const repo = mkdtempSync(join(tmpdir(), "dim-grok-git-"));
    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
    const checkout = realpathSync(repo);
    const argv = grokArgs({ ...request, cwd: checkout, capabilities: ["edit-files"] });
    rmSync(repo, { recursive: true, force: true });
    const gitPath = join(checkout, ".git");

    expect(denies(argv)).toEqual([
      `Edit(/${gitPath})`,
      `Edit(/${gitPath}/**)`,
      `Write(/${gitPath})`,
      `Write(/${gitPath}/**)`,
    ]);
  });

  test("passes a station schema inline and resumes by provider id", () => {
    const argv = grokArgs({
      ...request,
      outputSchema: `${import.meta.dir}/station-plan-artifact.schema.json`,
    });
    expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1] ?? "")).toHaveProperty("properties.slices");
    expect(resumeCommandLine(grokProcess, "session-1", request).slice(0, 3)).toEqual([
      "grok",
      "--resume",
      "session-1",
    ]);
  });

  test("does not pass an API key through to the worker", () => {
    expect(
      grokProcess.environment?.({
        XAI_API_KEY: "xai-key",
        GROK_CODE_XAI_API_KEY: "legacy-key",
        PATH: "/bin",
      }),
    ).toEqual({ PATH: "/bin" });
  });
});
