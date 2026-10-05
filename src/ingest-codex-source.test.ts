import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRolloutLines, scratchEnv, writeCodexRollout } from "./fixtures.test-support";
import { listCodexRollouts } from "./ingest-codex-source";

const THREAD = "01a0a651-086e-7150-8650-cef0f4025a58";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parseWithState(state: unknown) {
  const root = mkdtempSync(join(tmpdir(), "dim-test-"));
  roots.push(root);
  const env = scratchEnv(root);
  writeCodexRollout(env, "sessions", THREAD);
  const [spec] = listCodexRollouts(env);
  const lines = codexRolloutLines(THREAD, { withIds: true })
    .map((l) => JSON.stringify(l))
    .filter((l) => l.includes("response_item"));
  return spec?.parse(lines, 1, JSON.stringify(state));
}

describe("listCodexRollouts", () => {
  test("reads cursor state that fails its schema as empty", () => {
    const parsed = parseWithState({ model: 5 });
    const assistant = parsed?.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.model).toBeUndefined();
  });

  test("carries the model from cursor state that passes its schema", () => {
    const parsed = parseWithState({ model: "gpt-x" });
    expect(parsed?.messages.find((m) => m.role === "assistant")?.model).toBe("gpt-x");
  });
});
