import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Env } from "./paths";

export function scratchEnv(root: string): Env {
  return {
    DIM_HOME: join(root, "home"),
    DIM_CLAUDE_PROJECTS: join(root, "claude-projects"),
    DIM_CODEX_DIR: join(root, "codex"),
  };
}

function writeLines(path: string, lines: unknown[]): string {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  writeFileSync(path, body);
  return body;
}

/** Write only the first `bytes` of what the full file would hold. */
export function writePrefix(path: string, lines: unknown[], bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  writeFileSync(path, Buffer.from(body, "utf8").subarray(0, bytes));
}

/** Byte length of the file up to and including line `index`. */
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

/**
 * A transcript with the shapes the parser has to get right: one API response
 * split across two content-block lines, a tool_result-only user line, a
 * thinking-only assistant line, and a skill body.
 */
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
        // Mid-stream: usage accumulates across a response's content-block
        // lines, and only the line carrying a stop_reason holds the total.
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
  ];
}

export function writeClaudeTranscript(env: Env, slug: string, sessionId: string): string {
  const path = join(env.DIM_CLAUDE_PROJECTS as string, slug, `${sessionId}.jsonl`);
  writeLines(path, claudeTranscriptLines(sessionId));
  return path;
}

/**
 * A rollout in both dialects: the modern one names an id on each message, the
 * pre-August one leaves it null and is addressed by (thread id, ordinal).
 */
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
  ];
}

export function writeCodexRollout(env: Env, dir: "sessions" | "archived_sessions", threadId: string): string {
  const name = `rollout-2026-09-16T10-00-00-${threadId}.jsonl`;
  const path =
    dir === "sessions"
      ? join(env.DIM_CODEX_DIR as string, "sessions", "2026", "09", "16", name)
      : join(env.DIM_CODEX_DIR as string, "archived_sessions", name);
  writeLines(path, codexRolloutLines(threadId, { withIds: true }));
  return path;
}
