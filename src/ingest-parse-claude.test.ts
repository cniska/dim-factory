import { describe, expect, test } from "bun:test";
import { claudeTranscriptLines } from "./fixtures.test-support";
import { parseClaudeChunk } from "./ingest-parse-claude";

const lines = claudeTranscriptLines("s-1").map((l) => JSON.stringify(l));
const parsed = parseClaudeChunk(lines, 1);

describe("parseClaudeChunk", () => {
  test("writes one usage row per content-block line so the ingester can dedupe on message id", () => {
    expect(parsed.usage.filter((u) => u.responseId === "msg-1")).toHaveLength(2);
    expect(new Set(parsed.usage.map((u) => u.responseId)).size).toBe(1);
  });

  test("keeps thinking blocks out of the message text", () => {
    const text = parsed.messages
      .filter((m) => m.id === "msg-1")
      .map((m) => m.text)
      .join("\n");
    expect(text).toContain("First half.");
    expect(text).toContain("Second half.");
    expect(text).not.toContain("SECRET REASONING");
  });

  test("keeps tool results out of the message text", () => {
    const toolResult = parsed.messages.find((m) => m.id === "u-2");
    expect(toolResult).toBeDefined();
    expect(toolResult?.text).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("SECRET FILE CONTENTS");
  });

  test("maps the token fields Claude reports, with input excluding cached reads", () => {
    const u = parsed.usage.at(-1);
    expect(u).toMatchObject({
      inputTokens: 5,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
      cacheWrite1hTokens: 200,
      outputTokens: 50,
      reasoningTokens: 30,
      attributionSkill: "build",
      model: "claude-opus-5",
    });
  });

  test("reports each line's own usage, partial figures included", () => {
    expect(parsed.usage.map((u) => u.outputTokens)).toEqual([9, 50]);
  });

  test("marks an injected skill body", () => {
    const body = parsed.messages.find((m) => m.id === "u-3");
    expect(body?.isMeta).toBe(true);
    expect(body?.isSkillBody).toBe(true);
    expect(parsed.messages.find((m) => m.id === "u-1")?.isSkillBody).toBe(false);
  });

  test("records the ways a user overrode the agent", () => {
    expect(parsed.messages.find((m) => m.id === "u-4")).toMatchObject({
      interruptedMessageId: "msg-1",
      denialKind: "user-rejected",
      userFeedback: "no, not like that",
    });
  });

  test("numbers src_line from the file, not the chunk", () => {
    expect(parsed.messages.find((m) => m.id === "u-1")?.srcLine).toBe(2);
    const later = parseClaudeChunk(lines.slice(1), 2);
    expect(later.messages.find((m) => m.id === "u-1")?.srcLine).toBe(2);
  });

  test("carries prompt provenance and the skill a turn ran under", () => {
    expect(parsed.messages.find((m) => m.id === "u-1")).toMatchObject({
      promptSource: "typed",
      originKind: "human",
      turnId: "p-1",
    });
    expect(parsed.messages.find((m) => m.id === "msg-1")?.attributionSkill).toBe("build");
  });

  test("takes the session title from an ai-title line", () => {
    expect(parsed.session.some((s) => s.title === "Add the parser")).toBe(true);
  });

  test("names the line number of a complete line that is not JSON", () => {
    const corrupt = parseClaudeChunk([lines[0] as string, "{not json", lines[1] as string], 10);
    expect(corrupt.dropped).toEqual([11]);
    expect(corrupt.messages.length).toBeGreaterThan(0);
  });

  test("reports nothing dropped for a chunk that parsed whole", () => {
    expect(parsed.dropped).toEqual([]);
  });
});
