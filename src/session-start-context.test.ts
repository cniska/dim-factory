import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectLine, wireFor } from "./session-start-context";

describe("session-start context", () => {
  test("carries the checkout's declared check and format tasks", () => {
    const repo = mkdtempSync(join(tmpdir(), "dim-session-start-"));
    try {
      mkdirSync(join(repo, ".git"));
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ scripts: { verify: "bun test", format: "biome format", lint: "biome lint" } }),
      );
      writeFileSync(join(repo, "bun.lock"), "");
      mkdirSync(join(repo, "docs"));
      writeFileSync(join(repo, "docs", "Makefile"), "test:\n\techo hi\n");

      const line = projectLine(join(repo, "docs"));
      expect(line).toContain("check `bun run verify`");
      expect(line).toContain("format `bun run format`");
      expect(line).not.toContain("lint");
      expect(line).not.toContain("make test");
      expect(wireFor("claude", line)).toBe(line);
      expect(JSON.parse(wireFor("codex", line))).toEqual({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("prints nothing when the directory has no declared tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "dim-session-start-"));
    try {
      mkdirSync(join(root, ".git"));
      expect(projectLine(root)).toBe("");
      expect(wireFor("codex", "")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
