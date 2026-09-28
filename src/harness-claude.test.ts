import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRequest } from "./harness";
import { claudeArgs, claudeProcess } from "./harness-claude";
import { commandLine, resumeCommandLine } from "./harness-process";
import { workerEnvironment } from "./station-environment";

const PER_TOKEN = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

const request: HarnessRequest = {
  cwd: "/repo",
  brief: "build it",
  model: "claude-model",
  capabilities: [],
  env: { DIM_HOME: "/dim-home" },
};

const WORKER_ENV = {
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  CLAUDE_CODE_USE_BEDROCK: "",
  CLAUDE_CODE_USE_VERTEX: "",
  CLAUDE_CODE_USE_FOUNDRY: "",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
};

const SCHEDULING_TOOLS = ["ScheduleWakeup", "CronCreate", "Monitor", "RemoteTrigger"];

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
    expect(parseAll([{ type: "system", subtype: "init", session_id: "s1", apiKeySource: "none" }])).toEqual([
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

  test("names a usage limit and when it resets, from the rate-limit event Claude streams", () => {
    const limitText = "You've hit your session limit · resets 7:50pm (Europe/Helsinki)";
    expect(
      parseAll([
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", resetsAt: 1790527800, rateLimitType: "five_hour" },
        },
        {
          type: "assistant",
          error: "rate_limit",
          message: { content: [{ type: "text", text: limitText }] },
        },
        { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: limitText },
      ]),
    ).toEqual([
      { type: "message", role: "assistant", text: limitText },
      { type: "run.failed", reason: limitText, usageLimit: { resetsAt: "2026-09-27T16:50:00.000Z" } },
    ]);
  });

  test("an allowed rate-limit event is no limit", () => {
    expect(
      parseAll([
        { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1790527800 } },
        { type: "result", subtype: "error_max_turns", is_error: true },
      ]),
    ).toEqual([{ type: "run.failed", reason: "error_max_turns" }]);
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
      env: WORKER_ENV,
      hooks: expect.any(Object),
      permissions: { deny: SCHEDULING_TOOLS },
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
      env: WORKER_ENV,
      hooks: expect.any(Object),
      permissions: { deny: ["Edit", "Write", "NotebookEdit", ...SCHEDULING_TOOLS] },
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

  test("gives a builder the record and none of the repository metadata", () => {
    const argv = claudeArgs({ ...request, cwd: process.cwd(), capabilities: ["edit-files"] });

    expect(addDirs(argv)).toEqual(["/dim-home"]);
  });

  test("denies a builder the .git the runner's git follows, as a worktree pointer or a checkout's own", () => {
    const repo = mkdtempSync(join(tmpdir(), "dim-git-pointers-"));
    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "worktree", "add", "-q", join(repo, "order"), "-b", "order");
    const denied = (cwd: string) =>
      settings(claudeArgs({ ...request, cwd, capabilities: ["edit-files"] })) as {
        permissions: { deny: string[] };
        sandbox: { filesystem: { denyWrite: string[] } };
      };
    const worktree = realpathSync(join(repo, "order"));
    const checkout = realpathSync(repo);

    const inWorktree = denied(worktree);
    const inCheckout = denied(checkout);
    rmSync(repo, { recursive: true, force: true });

    expect(inWorktree.sandbox.filesystem.denyWrite).toEqual([join(worktree, ".git"), join(checkout, ".git")]);
    expect(inWorktree.permissions.deny).toEqual([
      `Edit(/${join(worktree, ".git")})`,
      `Edit(/${join(worktree, ".git")}/**)`,
      `Edit(/${join(checkout, ".git")})`,
      `Edit(/${join(checkout, ".git")}/**)`,
      ...SCHEDULING_TOOLS,
    ]);
    expect(inCheckout.sandbox.filesystem.denyWrite).toEqual([join(checkout, ".git")]);
  });

  test("denies a worker without edit-files the git dir its worktree shares with the checkout", () => {
    const repo = mkdtempSync(join(tmpdir(), "dim-git-common-"));
    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "worktree", "add", "-q", join(repo, "order"), "-b", "order");
    const worktree = realpathSync(join(repo, "order"));
    const checkout = realpathSync(repo);

    const reviewer = settings(claudeArgs({ ...request, cwd: worktree })) as {
      sandbox: { filesystem: { denyWrite: string[] } };
    };
    rmSync(repo, { recursive: true, force: true });

    expect(reviewer.sandbox.filesystem.denyWrite).toEqual([worktree, join(checkout, ".git")]);
  });

  test("passes a station's response schema inline, as Claude reads it", () => {
    const argv = claudeArgs({
      ...request,
      outputSchema: `${import.meta.dir}/station-plan-artifact.schema.json`,
    });
    const schema = argv[argv.indexOf("--json-schema") + 1] ?? "";

    expect(JSON.parse(schema)).toHaveProperty("properties.slices");
  });

  test("resumes a Claude session by its provider id with the same boundary", () => {
    const builder: HarnessRequest = { ...request, capabilities: ["edit-files"] };

    expect(resumeCommandLine(claudeProcess, "session-1", builder)).toEqual([
      "claude",
      "--resume",
      "session-1",
      ...claudeArgs(builder),
    ]);
  });

  test("keeps every per-token credential and provider out of a worker, from the shell and from settings", () => {
    const env = workerEnvironment(claudeProcess.environment, {
      DIM_WORKER_NAME: "worker-1",
      CLAUDE_CONFIG_DIR: "/claude-config",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_AUTH_TOKEN: "bearer",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
    });

    expect(env).toMatchObject({
      DIM_WORKER_NAME: "worker-1",
      CLAUDE_CONFIG_DIR: "/claude-config",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
    });
    for (const name of PER_TOKEN) expect(env[name]).toBeUndefined();
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

  test("loads no settings of the owner's or the worktree's, and spools into the worker's own record", () => {
    const argv = claudeArgs(request);
    const launched = settings(argv) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const spooled = (event: string) =>
      launched.hooks[event]?.flatMap((entry) => entry.hooks.map((h) => h.command));
    const spool = `cat > "/dim-home/spool/claude/$(date +%s%N)-$$-\${DIM_WORKER_NAME:-}.json" 2>/dev/null; exit 0 # dim-hook:3`;

    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(spooled("SessionStart")).toContain(
      `cat > "/dim-home/spool/claude/$(date +%s%N)-$$-$PPID-\${DIM_WORKER_NAME:-}.json" 2>/dev/null; exit 0 # dim-hook:3`,
    );
    expect(spooled("SessionEnd")).toContain(spool);
    expect(spooled("PostToolUse")).toContain(spool);
  });

  test("gives no worker a way to leave work running past its answer", () => {
    for (const capabilities of [["edit-files"], []] as const) {
      const launched = settings(claudeArgs({ ...request, cwd: process.cwd(), capabilities })) as {
        env: Record<string, string>;
        permissions: { deny: string[] };
      };

      expect(launched.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
      expect(launched.permissions.deny).toEqual(expect.arrayContaining(SCHEDULING_TOOLS));
    }
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

  test("refuses an init event that does not report its API key source", () => {
    expect(parseAll([{ type: "system", subtype: "init", session_id: "s1" }])).toEqual([
      {
        type: "run.failed",
        reason: "Claude did not report its API key source; cannot verify billing for this worker",
      },
    ]);
  });

  test("turns malformed output into a visible diagnostic", () => {
    expect(parseAll(["not json"])).toEqual([
      { type: "diagnostic", level: "error", message: "Claude emitted invalid JSON" },
    ]);
  });
});
