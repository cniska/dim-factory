import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeArgs, claudeProcess } from "./claude-harness";
import type { HarnessRequest } from "./harness";
import { commandLine, resumeCommandLine } from "./harness-process";

const request: HarnessRequest = {
  cwd: "/repo",
  brief: "build it",
  model: "claude-model",
  capabilities: [],
  env: { DIM_HOME: "/dim-home" },
};

const BLANKED = {
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  CLAUDE_CODE_USE_BEDROCK: "",
  CLAUDE_CODE_USE_VERTEX: "",
  CLAUDE_CODE_USE_FOUNDRY: "",
};

function settings(argv: string[]): unknown {
  return JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "");
}

function addDirs(argv: string[]): string[] {
  return argv.flatMap((arg, index) => (arg === "--add-dir" ? [argv[index + 1] ?? ""] : []));
}

function parseAll(lines: unknown[]) {
  const parse = claudeProcess.parser();
  return lines.flatMap((line) => {
    const parsed = parse(typeof line === "string" ? line : JSON.stringify(line));
    return parsed === undefined ? [] : Array.isArray(parsed) ? parsed : [parsed];
  });
}

describe("the Claude harness adapter", () => {
  test("starts a run on the init event and names its session", () => {
    expect(parseAll([{ type: "system", subtype: "init", session_id: "s1" }])).toEqual([
      { type: "run.started", providerSessionId: "s1" },
      { type: "turn.started" },
    ]);
    expect(parseAll([{ type: "system", subtype: "thinking_tokens", session_id: "s1" }])).toEqual([]);
  });

  test("maps assistant text and a tool call to the result that answers it", () => {
    expect(
      parseAll([
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "" },
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } },
            ],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hi", is_error: false }] },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "denied" }] },
            ],
          },
        },
        { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      ]),
    ).toEqual([
      { type: "tool.started", name: "Bash", toolId: "t1" },
      { type: "tool.output", name: "Bash", text: "hi", toolId: "t1" },
      { type: "tool.completed", name: "Bash", toolId: "t1" },
      { type: "tool.output", name: "tool_result", text: "denied", toolId: "t2" },
      { type: "tool.completed", name: "tool_result", toolId: "t2" },
      { type: "message", role: "assistant", text: "ok" },
    ]);
  });

  test("completes with the schema-validated answer when a schema was given, and the result text otherwise", () => {
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
      ]),
    ).toEqual([
      { type: "run.completed", output: '{"answer":"ok"}' },
      { type: "run.completed", output: "Done." },
    ]);
  });

  test("fails a result Claude marks as an error, even under the success subtype", () => {
    expect(
      parseAll([
        { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" },
        { type: "result", subtype: "error_max_turns", is_error: true },
        { type: "result", is_error: true },
      ]),
    ).toEqual([
      { type: "run.failed", reason: "Not logged in · Please run /login" },
      { type: "run.failed", reason: "error_max_turns" },
      { type: "run.failed", reason: "Claude run failed" },
    ]);
  });

  test("gives a builder edits inside a sandbox that cannot fall back to running unconfined", () => {
    const argv = commandLine(claudeProcess, { ...request, capabilities: ["edit-files"] });

    expect(argv.slice(0, 7)).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(settings(argv)).toEqual({
      env: BLANKED,
      permissions: { deny: [] },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: [] },
      },
    });
    expect(argv.slice(-4)).toEqual(["--model", "claude-model", "--", "build it"]);
  });

  test("denies a worker without edit-files the editing tools and every sandboxed write to the checkout", () => {
    const cwd = process.cwd();
    const argv = claudeArgs({ ...request, cwd });

    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
    expect(settings(argv)).toEqual({
      env: BLANKED,
      permissions: { deny: ["Edit", "Write", "NotebookEdit"] },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: [cwd] },
      },
    });
    expect(addDirs(argv)).toEqual(["/dim-home"]);
  });

  test("lets a builder reach the record and the repository metadata", () => {
    const cwd = process.cwd();
    const gitDirs = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--git-dir", "--git-common-dir"])
      .stdout.toString()
      .trim()
      .split("\n")
      .map((dir) => resolve(cwd, dir));

    const argv = claudeArgs({ ...request, cwd, capabilities: ["edit-files"] });

    expect(addDirs(argv)).toEqual(["/dim-home", ...new Set(gitDirs)]);
    const denied = settings(argv) as {
      permissions: { deny: string[] };
      sandbox: { filesystem: { denyWrite: string[] } };
    };
    expect(denied.sandbox.filesystem.denyWrite.length).toBeGreaterThan(0);
    expect(denied.permissions.deny).toEqual(
      denied.sandbox.filesystem.denyWrite.flatMap((path) => [`Edit(/${path})`, `Edit(/${path}/**)`]),
    );
  });

  test("denies a builder every git pointer that could send the operator's git to a config it wrote", () => {
    const repo = mkdtempSync(join(tmpdir(), "dim-git-pointers-"));
    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(repo, "worktree", "add", "-q", join(repo, "order"), "-b", "order");
    const common = realpathSync(join(repo, ".git"));
    const cwd = realpathSync(join(repo, "order"));

    const denied = (
      settings(claudeArgs({ ...request, cwd, capabilities: ["edit-files"] })) as {
        sandbox: { filesystem: { denyWrite: string[] } };
      }
    ).sandbox.filesystem.denyWrite;
    rmSync(repo, { recursive: true, force: true });

    expect(denied).toEqual([
      join(common, "config"),
      join(common, "config.worktree"),
      join(common, "hooks"),
      join(common, "info"),
      join(common, "modules"),
      join(common, "refs", "replace"),
      join(common, "shallow"),
      join(common, "worktrees", "*", "commondir"),
      join(common, "worktrees", "*", "gitdir"),
      join(common, "worktrees", "*", "config.worktree"),
      join(cwd, ".git"),
      join(common, "packed-refs"),
      join(common, "refs", "remotes", "origin", "HEAD"),
      join(common, "refs", "heads", "main"),
    ]);
  });

  test("passes a station's response schema inline, as Claude reads it", () => {
    const argv = claudeArgs({
      ...request,
      outputSchema: `${import.meta.dir}/plan-artifact.schema.json`,
    });
    const schema = argv[argv.indexOf("--json-schema") + 1] ?? "";

    expect(JSON.parse(schema)).toHaveProperty("properties.slices");
  });

  test("resumes a Claude session by its provider id with the same boundary", () => {
    expect(
      resumeCommandLine(claudeProcess, "session-1", { ...request, capabilities: ["edit-files"] }),
    ).toEqual([
      "claude",
      "--resume",
      "session-1",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--settings",
      '{"env":{"ANTHROPIC_API_KEY":"","ANTHROPIC_AUTH_TOKEN":"","CLAUDE_CODE_USE_BEDROCK":"","CLAUDE_CODE_USE_VERTEX":"","CLAUDE_CODE_USE_FOUNDRY":""},"permissions":{"deny":[]},"sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"filesystem":{"denyWrite":[]}}}',
      "--add-dir",
      "/dim-home",
      "--model",
      "claude-model",
      "--",
      "build it",
    ]);
  });

  test("keeps every per-token credential and provider out of a worker, from the shell and from settings", () => {
    const env = claudeProcess.environment?.({
      PATH: "/bin",
      DIM_WORKER_TOKEN: "worker-token",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_AUTH_TOKEN: "bearer",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
    });

    expect(env).toEqual({
      PATH: "/bin",
      DIM_WORKER_TOKEN: "worker-token",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
    });
    expect(settings(claudeArgs(request))).toMatchObject({
      env: {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_USE_BEDROCK: "",
        CLAUDE_CODE_USE_VERTEX: "",
        CLAUDE_CODE_USE_FOUNDRY: "",
      },
    });
  });

  test("refuses to run a worker Claude would bill per token", () => {
    expect(
      parseAll([
        { type: "system", subtype: "init", session_id: "s1", apiKeySource: "apiKeyHelper" },
        { type: "system", subtype: "init", session_id: "s2", apiKeySource: "none" },
      ]),
    ).toEqual([
      {
        type: "run.failed",
        reason:
          "Claude would bill this worker per token through apiKeyHelper; sign in with a subscription instead",
      },
      { type: "run.started", providerSessionId: "s2" },
      { type: "turn.started" },
    ]);
  });

  test("turns malformed output into a visible diagnostic", () => {
    expect(parseAll(["not json"])).toEqual([
      { type: "diagnostic", level: "error", message: "Claude emitted invalid JSON" },
    ]);
  });
});
