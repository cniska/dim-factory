import { describe, expect, test } from "bun:test";
import { codexRolloutLines } from "./fixtures.test-support";
import { parseCodexChunk } from "./ingest-parse-codex";

const THREAD = "01a0a651-086e-7150-8650-cef0f4025a58";
const modern = codexRolloutLines(THREAD, { withIds: true }).map((l) => JSON.stringify(l));
const legacy = codexRolloutLines(THREAD, { withIds: false }).map((l) => JSON.stringify(l));

describe("parseCodexChunk", () => {
  test("attributes each message to the model of the turn it belongs to", () => {
    const parsed = parseCodexChunk(modern, 1, THREAD, {});
    const assistants = parsed.messages.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    expect(assistants.map((m) => m.turnId)).toEqual(["turn-1", "turn-2"]);
  });

  test("addresses a message with no id by thread and the line it is on", () => {
    const parsed = parseCodexChunk(legacy, 1, THREAD, {});
    expect(parsed.messages).toHaveLength(3);
    expect(new Set(parsed.messages.map((m) => m.id)).size).toBe(3);
    expect(parsed.messages[0]?.id).toBe(`${THREAD}:3`);
  });

  test("points each message at the line of the file it came from", () => {
    const parsed = parseCodexChunk(modern, 10, THREAD, {});
    expect(parsed.messages.length).toBeGreaterThan(0);
    for (const message of parsed.messages) {
      const line = JSON.parse(modern[message.srcLine - 10] ?? "{}");
      expect(line.payload?.id).toBe(message.id);
    }
  });

  test("maps the token fields Codex reports, with input including cached reads", () => {
    const parsed = parseCodexChunk(modern, 1, THREAD, {});
    expect(parsed.usage).toHaveLength(1);
    expect(parsed.usage[0]).toMatchObject({
      responseId: `resp-${THREAD}-1`,
      inputTokens: 18018,
      cacheReadTokens: 9984,
      cacheWriteTokens: 0,
      outputTokens: 305,
      model: "gpt-5.6-luna",
    });
  });

  test("resumes the turn in effect when a chunk starts after the turn_context", () => {
    const tail = modern.slice(2);
    const cold = parseCodexChunk(tail, 1, THREAD, {});
    expect(cold.usage[0]?.model).toBeUndefined();

    const warm = parseCodexChunk(tail, 1, THREAD, { model: "gpt-5.6-luna", turnId: "turn-1" });
    expect(warm.usage[0]?.model).toBe("gpt-5.6-luna");
    expect(warm.messages[0]?.turnId).toBe("turn-1");
  });

  test("records a turn that has started and not ended with its start and no end", () => {
    const opened = parseCodexChunk(modern.slice(0, 2), 1, THREAD, {});
    expect(opened.turns).toEqual([
      {
        turnId: "turn-1",
        tsStart: JSON.parse(modern[1] ?? "{}").timestamp,
        status: "started",
        model: "gpt-5.6-luna",
      },
    ]);
  });

  test("names an abort that gives no reason as a line it could not read", () => {
    const abort = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-09-16T10:09:00.000Z",
      payload: { type: "turn_aborted", turn_id: "turn-9" },
    });
    const parsed = parseCodexChunk([abort], 5, THREAD, {});
    expect(parsed.turns).toEqual([]);
    expect(parsed.dropped).toEqual([5]);
  });

  test("hands back the turn state for the next chunk", () => {
    const parsed = parseCodexChunk(modern, 1, THREAD, {});
    expect(JSON.parse(parsed.cursorState ?? "{}")).toEqual({ model: "gpt-5.6-sol", turnId: "turn-2" });
  });

  test("takes session facts from session_meta", () => {
    const parsed = parseCodexChunk(modern, 1, THREAD, {});
    expect(parsed.session[0]).toMatchObject({
      cwd: "/Users/x/code/demo",
      gitBranch: "main",
      cliVersion: "0.154.0",
      entrypoint: "codex-tui",
    });
  });
  test("marks a typed prompt apart from what the harness injected", () => {
    const parsed = parseCodexChunk(modern, 1, THREAD, {});
    const typed = parsed.messages.find((m) => m.text === "add the parser");
    expect(typed?.promptSource).toBe("typed");

    const withInjected = parseCodexChunk(
      [
        ...modern,
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-16T10:09:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions for /Users/x/code/demo" }],
          },
        }),
      ],
      1,
      THREAD,
      {},
    );
    const rules = withInjected.messages.find((m) => m.text?.startsWith("# AGENTS.md"));
    expect(rules?.promptSource).toBe("system");
  });

  test("refuses a line with no timestamp rather than writing its rows untimed", () => {
    const untimed = codexRolloutLines(THREAD, { withIds: true }).map((line, index) => {
      if (index !== 3 && index !== 4) return JSON.stringify(line);
      const { timestamp: _, ...rest } = line as Record<string, unknown>;
      return JSON.stringify(rest);
    });
    const parsed = parseCodexChunk(untimed, 1, THREAD, {});
    expect(parsed.dropped).toEqual([4, 5]);
    expect(parsed.messages.map((m) => m.ts)).toEqual([
      "2026-09-16T10:03:00.000Z",
      "2026-09-16T10:07:00.000Z",
    ]);
    expect(parsed.usage).toEqual([]);
  });

  test("drops a line whose read field has the wrong type, and writes no row from it", () => {
    const completed = (exitCode: unknown) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-16T10:00:00.000Z",
        payload: {
          type: "item_completed",
          item: { id: "item-1", type: "CommandExecution", exit_code: exitCode },
        },
      });
    const parsed = parseCodexChunk([completed("1"), completed(1)], 1, THREAD, {});
    expect(parsed.dropped).toEqual([1]);
    expect(parsed.toolCalls).toMatchObject([{ id: "item-1", exitCode: 1 }]);
  });

  test("keeps lines whose model, turn id, usage and status are null", () => {
    const at = "2026-09-16T10:00:00.000Z";
    const parsed = parseCodexChunk(
      [
        JSON.stringify({ type: "turn_context", timestamp: at, payload: { model: null, turn_id: null } }),
        JSON.stringify({
          type: "token_usage_record",
          timestamp: at,
          payload: { response_id: "r-1", usage: null },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: at,
          payload: { type: "item_completed", item: { id: "i-1", type: "FileChange", status: null } },
        }),
      ],
      1,
      THREAD,
      {},
    );
    expect(parsed.dropped).toEqual([]);
    expect(parsed.usage).toMatchObject([{ responseId: "r-1", outputTokens: 0 }]);
    expect(parsed.toolCalls).toMatchObject([{ id: "i-1", isError: undefined }]);
  });

  test("keeps a message line whose payload id and content blocks are null", () => {
    const line = JSON.stringify({
      type: "response_item",
      timestamp: "2026-09-16T10:00:00.000Z",
      payload: {
        type: "message",
        role: "user",
        id: null,
        content: [null, { type: "input_text", text: "hi" }],
      },
    });
    const parsed = parseCodexChunk([line], 4, THREAD, {});
    expect(parsed.dropped).toEqual([]);
    expect(parsed.messages).toMatchObject([{ id: `${THREAD}:4`, text: "hi" }]);
  });
});
