import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SCHEMA_SQL } from "./db-schema";
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

  test("wake prints repo commands without injecting a stored handoff", () => {
    const root = mkdtempSync(join(tmpdir(), "dim-session-start-"));
    const repo = join(root, "repo");
    const data = join(root, "data");
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(data);
      writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { verify: "bun test" } }));
      writeFileSync(join(repo, "bun.lock"), "");
      const db = new Database(join(data, "sessions.db"));
      db.run(SCHEMA_SQL);
      db.run(
        `INSERT INTO session (id, tool, cwd, started_at, last_seen_at)
         VALUES ('previous', 'claude', ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
        [repo],
      );
      db.run(
        `INSERT INTO factory_handoff (message_id, session_id, role, ts, title, next)
         VALUES ('handoff', 'previous', 'assistant', '2026-09-01T00:00:00Z', '# Handoff', 'private next move')`,
      );
      db.close();

      const run = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "cli.ts"), "wake"], {
        env: { ...process.env, DIM_HOME: data },
        stdin: new Blob([JSON.stringify({ cwd: repo })]),
      });
      expect(run.exitCode).toBe(0);
      const output = new TextDecoder().decode(run.stdout);
      expect(output).toContain("check `bun run verify`");
      expect(output).not.toContain("private next move");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
