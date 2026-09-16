import { describe, expect, test } from "bun:test";
import { codexRolloutLines } from "./fixtures.test-support";
import { parseCodexChunk } from "./parse-codex";

const THREAD = "01a0a651-086e-7150-8650-cef0f4025a58";
const modern = codexRolloutLines(THREAD, { withIds: true }).map((l) => JSON.stringify(l));
const legacy = codexRolloutLines(THREAD, { withIds: false }).map((l) => JSON.stringify(l));

describe("parseCodexChunk", () => {
  test("attributes each message to the model of the turn it belongs to", () => {
    const parsed = parseCodexChunk(modern, THREAD, {});
    const assistants = parsed.messages.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    expect(assistants.map((m) => m.turnId)).toEqual(["turn-1", "turn-2"]);
  });

  test("addresses a message with no id by thread and ordinal", () => {
    const parsed = parseCodexChunk(legacy, THREAD, {});
    // Pre-August rollouts leave every id null; keying on it collapses the thread
    // into a single row.
    expect(parsed.messages).toHaveLength(3);
    expect(new Set(parsed.messages.map((m) => m.id)).size).toBe(3);
    expect(parsed.messages[0]?.id).toBe(`${THREAD}:2`);
  });

  test("maps the token fields Codex reports, with input including cached reads", () => {
    const parsed = parseCodexChunk(modern, THREAD, {});
    expect(parsed.usage).toHaveLength(1);
    expect(parsed.usage[0]).toMatchObject({
      responseId: `resp-${THREAD}-1`,
      inputTokens: 18018,
      cacheReadTokens: 9984,
      cacheWriteTokens: 0,
      outputTokens: 305,
      reasoningTokens: 94,
      model: "gpt-5.6-luna",
    });
  });

  test("resumes the turn in effect when a chunk starts after the turn_context", () => {
    const tail = modern.slice(2);
    const cold = parseCodexChunk(tail, THREAD, {});
    expect(cold.usage[0]?.model).toBeUndefined();

    const warm = parseCodexChunk(tail, THREAD, { model: "gpt-5.6-luna", turnId: "turn-1" });
    expect(warm.usage[0]?.model).toBe("gpt-5.6-luna");
    expect(warm.messages[0]?.turnId).toBe("turn-1");
  });

  test("hands back the turn state for the next chunk", () => {
    const parsed = parseCodexChunk(modern, THREAD, {});
    expect(JSON.parse(parsed.cursorState ?? "{}")).toEqual({ model: "gpt-5.6-sol", turnId: "turn-2" });
  });

  test("takes session facts from session_meta", () => {
    const parsed = parseCodexChunk(modern, THREAD, {});
    expect(parsed.session[0]).toMatchObject({
      cwd: "/Users/x/code/demo",
      gitBranch: "main",
      cliVersion: "0.154.0",
      entrypoint: "codex-tui",
    });
  });
  test("marks a typed prompt apart from what the harness injected", () => {
    const parsed = parseCodexChunk(modern, THREAD, {});
    const typed = parsed.messages.find((m) => m.text === "add the parser");
    // Codex records no prompt source of its own, so every user turn arrives
    // looking the same; without this the corpus cannot tell a prompt from an
    // injected rules block, and both tools' prompt counts stop comparing.
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
      THREAD,
      {},
    );
    const rules = withInjected.messages.find((m) => m.text?.startsWith("# AGENTS.md"));
    expect(rules?.promptSource).toBe("system");
  });
});
