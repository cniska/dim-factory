import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { claudeProjectsDir, codexDir, type Env } from "./paths";

export function harnessesOnPath(root: string, executables: readonly string[]): string {
  const bin = join(root, "harness-bin");
  mkdirSync(bin, { recursive: true });
  for (const name of executables) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

export function scratchEnv(root: string): Env {
  return {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    PATH: `${harnessesOnPath(root, ["claude"])}:${process.env.PATH}`,
  };
}

function writeLines(path: string, lines: unknown[]): string {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  writeFileSync(path, body);
  return body;
}

export function writePrefix(path: string, lines: unknown[], bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  writeFileSync(path, Buffer.from(body, "utf8").subarray(0, bytes));
}

export function bytesThroughLine(lines: unknown[], index: number): number {
  return Buffer.byteLength(
    `${lines
      .slice(0, index + 1)
      .map((l) => JSON.stringify(l))
      .join("\n")}\n`,
    "utf8",
  );
}

export function fullBytes(lines: unknown[]): number {
  return Buffer.byteLength(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
}

const TS = (n: number) => `2026-09-16T10:${String(n).padStart(2, "0")}:00.000Z`;

export function claudeTranscriptLines(sessionId: string): unknown[] {
  const base = {
    sessionId,
    cwd: "/Users/x/code/demo",
    gitBranch: "main",
    version: "2.1.260",
    entrypoint: "cli",
    isSidechain: false,
    userType: "external",
  };
  return [
    { type: "mode", sessionId, mode: "auto" },
    {
      ...base,
      type: "user",
      uuid: "u-1",
      timestamp: TS(1),
      promptSource: "typed",
      promptId: "p-1",
      origin: { kind: "human" },
      message: { role: "user", content: "add the parser" },
    },
    {
      ...base,
      type: "assistant",
      uuid: "a-1a",
      timestamp: TS(2),
      requestId: "req-1",
      attributionSkill: "build",
      message: {
        id: "msg-1",
        model: "claude-opus-5",
        stop_reason: null,
        content: [
          { type: "thinking", thinking: "SECRET REASONING" },
          { type: "text", text: "First half." },
        ],
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
          cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 },
          output_tokens: 9,
          output_tokens_details: { thinking_tokens: 4 },
          service_tier: "standard",
        },
      },
    },
    {
      ...base,
      type: "assistant",
      uuid: "a-1b",
      timestamp: TS(3),
      requestId: "req-1",
      attributionSkill: "build",
      message: {
        id: "msg-1",
        model: "claude-opus-5",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Second half." },
          { type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls" } },
        ],
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
          cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 },
          output_tokens: 50,
          output_tokens_details: { thinking_tokens: 30 },
          service_tier: "standard",
        },
      },
    },
    {
      ...base,
      type: "user",
      uuid: "u-2",
      timestamp: TS(4),
      toolUseResult: { stdout: "SECRET FILE CONTENTS", stderr: "" },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "SECRET FILE CONTENTS" }],
      },
    },
    {
      ...base,
      type: "user",
      uuid: "u-3",
      timestamp: TS(5),
      isMeta: true,
      sourceToolUseID: "toolu-2",
      message: {
        role: "user",
        content: "Base directory for this skill: /Users/x/.claude/skills/build\n\n# Build",
      },
    },
    {
      ...base,
      type: "user",
      uuid: "u-4",
      timestamp: TS(6),
      interruptedMessageId: "msg-1",
      toolDenialKind: "user-rejected",
      userFeedback: "no, not like that",
      message: { role: "user", content: [{ type: "text", text: "stop" }] },
    },
    { type: "ai-title", sessionId, aiTitle: "Add the parser" },
    {
      ...base,
      type: "system",
      subtype: "turn_duration",
      uuid: "turn-1",
      timestamp: TS(7),
      durationMs: 7193,
      messageCount: 13,
    },
    {
      ...base,
      type: "cost-state",
      uuid: "cost-1",
      timestamp: TS(8),
      totalCostUSD: 9.611748,
      modelUsage: { "claude-opus-5[1m]": { inputTokens: 5, outputTokens: 50, costUSD: 9.611748 } },
      totalAPIDuration: 516997,
      totalLinesAdded: 45,
      totalLinesRemoved: 10,
      hasUnknownModelCost: false,
    },
  ];
}

export function writeClaudeTranscript(env: Env, slug: string, sessionId: string): string {
  const path = join(claudeProjectsDir(env), slug, `${sessionId}.jsonl`);
  writeLines(path, claudeTranscriptLines(sessionId));
  return path;
}

export function codexRolloutLines(threadId: string, opts: { withIds: boolean }): unknown[] {
  const id = (n: number) => (opts.withIds ? `msg-${threadId}-${n}` : null);
  return [
    {
      type: "session_meta",
      timestamp: TS(1),
      ordinal: 0,
      payload: {
        id: threadId,
        timestamp: TS(1),
        cwd: "/Users/x/code/demo",
        originator: "codex-tui",
        cli_version: "0.154.0",
        source: "cli",
        model_provider: "openai",
        history_mode: "paginated",
        git: { branch: "main" },
      },
    },
    {
      type: "turn_context",
      timestamp: TS(2),
      ordinal: 1,
      payload: { turn_id: "turn-1", model: "gpt-5.6-luna", cwd: "/Users/x/code/demo", effort: "medium" },
    },
    {
      type: "response_item",
      timestamp: TS(3),
      ordinal: 2,
      payload: {
        type: "message",
        id: id(2),
        role: "user",
        content: [{ type: "input_text", text: "add the parser" }],
      },
    },
    {
      type: "response_item",
      timestamp: TS(4),
      ordinal: 3,
      payload: {
        type: "message",
        id: id(3),
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      },
    },
    {
      type: "token_usage_record",
      timestamp: TS(5),
      ordinal: 4,
      payload: {
        thread_id: threadId,
        turn_id: "turn-1",
        response_id: `resp-${threadId}-1`,
        usage: {
          input_tokens: 18018,
          cached_input_tokens: 9984,
          cache_write_input_tokens: 0,
          output_tokens: 305,
          reasoning_output_tokens: 94,
          total_tokens: 18323,
        },
      },
    },
    {
      type: "turn_context",
      timestamp: TS(6),
      ordinal: 5,
      payload: { turn_id: "turn-2", model: "gpt-5.6-sol", cwd: "/Users/x/code/demo" },
    },
    {
      type: "response_item",
      timestamp: TS(7),
      ordinal: 6,
      payload: {
        type: "message",
        id: id(6),
        role: "assistant",
        content: [{ type: "output_text", text: "And more." }],
      },
    },
    {
      type: "event_msg",
      timestamp: TS(8),
      ordinal: 7,
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "SECRET AGENT MESSAGE",
        started_at: 1789496759,
        completed_at: 1789496911,
        duration_ms: 151652,
        time_to_first_token_ms: 4693,
      },
    },
    {
      type: "event_msg",
      timestamp: TS(9),
      ordinal: 8,
      payload: {
        type: "turn_aborted",
        turn_id: "turn-2",
        reason: "interrupted",
        started_at: 1789536555,
        completed_at: 1789536563,
        duration_ms: 8128,
      },
    },
  ];
}

export function writeCodexRollout(env: Env, dir: "sessions" | "archived_sessions", threadId: string): string {
  const name = `rollout-2026-09-16T10-00-00-${threadId}.jsonl`;
  const path =
    dir === "sessions"
      ? join(codexDir(env), "sessions", "2026", "09", "16", name)
      : join(codexDir(env), "archived_sessions", name);
  writeLines(path, codexRolloutLines(threadId, { withIds: true }));
  return path;
}

export function withoutTimestamp(line: unknown): string {
  const { timestamp: _, ...rest } = z.record(z.string(), z.unknown()).parse(line);
  return JSON.stringify(rest);
}
