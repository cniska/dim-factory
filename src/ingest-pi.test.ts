import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePiChunk } from "./ingest-parse-pi";
import { listPiSessions } from "./ingest-pi-source";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const LINES = [
  { type: "title", v: 1, title: "Greet the reader", source: "auto", updatedAt: "2026-01-01T10:30:00.000Z" },
  {
    type: "session",
    version: 3,
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    timestamp: "2026-01-01T10:00:00.000Z",
    cwd: "/home/dev/widgets",
  },
  {
    type: "model_change",
    id: "m1",
    parentId: null,
    timestamp: "2026-01-01T10:00:01.000Z",
    provider: "acme",
    modelId: "model-a",
  },
  {
    type: "thinking_level_change",
    id: "t1",
    parentId: "m1",
    timestamp: "2026-01-01T10:00:01.000Z",
    thinkingLevel: "high",
  },
  {
    type: "message",
    id: "u1",
    parentId: "t1",
    timestamp: "2026-01-01T10:01:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "add a greeting" }], timestamp: 1767261660000 },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-01-01T10:01:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "planning" },
        { type: "text", text: "Reading the readme first." },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
        { type: "toolCall", id: "call_2", name: "bash", arguments: { command: "bun test" } },
      ],
      provider: "acme",
      model: "model-a",
      usage: { input: 1000, output: 20, cacheRead: 100, cacheWrite: 7, reasoning: 5, totalTokens: 1132 },
      stopReason: "toolUse",
      responseId: "resp_1",
    },
  },
  {
    type: "message",
    id: "r1",
    parentId: "a1",
    timestamp: "2026-01-01T10:01:06.000Z",
    message: { role: "toolResult", toolCallId: "call_1", toolName: "read", isError: false, content: [] },
  },
  {
    type: "message",
    id: "r2",
    parentId: "r1",
    timestamp: "2026-01-01T10:01:08.000Z",
    message: { role: "toolResult", toolCallId: "call_2", toolName: "bash", isError: true, content: [] },
  },
  {
    type: "message",
    id: "d1",
    parentId: "r2",
    timestamp: "2026-01-01T10:02:00.000Z",
    message: { role: "developer", content: [{ type: "text", text: "a reminder from the harness" }] },
  },
  {
    type: "custom",
    customType: "tool_execution_start",
    data: {},
    id: "c1",
    timestamp: "2026-01-01T10:01:05.500Z",
  },
].map((line) => JSON.stringify(line));

describe("a Pi or omp session", () => {
  test("records the session's directory and title", () => {
    const { session } = parsePiChunk(LINES, 1);

    expect(session).toContainEqual({
      ts: "2026-01-01T10:00:00.000Z",
      cwd: "/home/dev/widgets",
      project: "/home/dev/widgets",
    });
    expect(session).toContainEqual({ title: "Greet the reader" });
  });

  test("records what the owner and the agent said, not its thinking or the harness's reminders", () => {
    const { messages } = parsePiChunk(LINES, 1);

    expect(
      messages.map(({ id, role, text, model, srcLine }) => ({ id, role, text, model, srcLine })),
    ).toEqual([
      { id: "u1", role: "user", text: "add a greeting", model: undefined, srcLine: 5 },
      { id: "a1", role: "assistant", text: "Reading the readme first.", model: "model-a", srcLine: 6 },
    ]);
  });

  test("records each tool call with its file or command, joined to its result", () => {
    const { toolCalls } = parsePiChunk(LINES, 1);

    expect(toolCalls).toEqual([
      {
        id: "call_1",
        tsCall: "2026-01-01T10:01:05.000Z",
        toolName: "read",
        filePath: "README.md",
        command: undefined,
        model: "model-a",
        srcLineCall: 6,
      },
      {
        id: "call_2",
        tsCall: "2026-01-01T10:01:05.000Z",
        toolName: "bash",
        filePath: undefined,
        command: "bun test",
        model: "model-a",
        srcLineCall: 6,
      },
      {
        id: "call_1",
        tsResult: "2026-01-01T10:01:06.000Z",
        toolName: "read",
        isError: false,
        srcLineResult: 7,
      },
      {
        id: "call_2",
        tsResult: "2026-01-01T10:01:08.000Z",
        toolName: "bash",
        isError: true,
        srcLineResult: 8,
      },
    ]);
  });

  test("records the tokens each response used", () => {
    const { usage } = parsePiChunk(LINES, 1);

    expect(usage).toEqual([
      {
        responseId: "resp_1",
        ts: "2026-01-01T10:01:05.000Z",
        model: "model-a",
        inputTokens: 1000,
        cacheReadTokens: 100,
        cacheWriteTokens: 7,
        outputTokens: 20,
        messageId: "a1",
      },
    ]);
  });

  test("names the message a response used tokens for only when that message holds text", () => {
    const silent = JSON.stringify({
      type: "message",
      id: "a2",
      timestamp: "2026-01-01T10:03:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_3", name: "bash", arguments: { command: "ls" } }],
        model: "model-a",
        usage: { input: 10, output: 2 },
        responseId: "resp_2",
      },
    });
    const { messages, usage } = parsePiChunk([silent], 1);

    expect(messages).toEqual([]);
    expect(usage.map(({ responseId, messageId }) => ({ responseId, messageId }))).toEqual([
      { responseId: "resp_2", messageId: undefined },
    ]);
  });

  test("sets aside a line that does not parse", () => {
    expect(parsePiChunk(["{not json", LINES[1] as string], 10).dropped).toEqual([10]);
  });
});

describe("listing sessions", () => {
  test("names each session file by the id in its file name", () => {
    const root = mkdtempSync(join(tmpdir(), "dim-pi-"));
    roots.push(root);
    const dir = join(root, "--home-dev-widgets--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-01-01T10-00-00-000Z_aaaaaaaa-0000-4000-8000-000000000001.jsonl"),
      `${LINES[1]}\n`,
    );

    expect(listPiSessions(root).map(({ kind, sessionId }) => ({ kind, sessionId }))).toEqual([
      { kind: "transcript", sessionId: "aaaaaaaa-0000-4000-8000-000000000001" },
    ]);
    expect(listPiSessions(join(root, "absent"))).toEqual([]);
  });
});
