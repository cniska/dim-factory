import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDb, openDb } from "./db";
import {
  bytesThroughLine,
  claudeTranscriptLines,
  codexRolloutLines,
  fullBytes,
  scratchEnv,
  writeClaudeTranscript,
  writeCodexRollout,
  writePrefix,
} from "./fixtures.test-support";
import { dbPath, type Env } from "./paths";
import { sync } from "./sync";

const SESSION = "11111111-2222-3333-4444-555555555555";
const THREAD = "01a0a651-086e-7150-8650-cef0f4025a58";
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function run(env: Env): Database {
  const db = openDb(dbPath(env));
  sync(db, env);
  return db;
}

/** Paths differ per scratch root, so compare them relative to that root. */
function snapshot(db: Database, root: string) {
  const strip = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
    rows.map((r) => ({
      ...r,
      src_file: typeof r.src_file === "string" ? r.src_file.replace(root, "") : r.src_file,
    }));
  return {
    sessions: db
      .prepare(
        `SELECT id, tool, parent_id, agent_type, cwd, project, git_branch, cli_version, entrypoint,
                started_at, last_seen_at, first_model, last_model, title FROM session ORDER BY id`,
      )
      .all() as Record<string, unknown>[],
    messages: strip(
      db
        .prepare(
          `SELECT id, session_id, role, model, ts, text, text_chars, src_file, src_line,
                  is_meta, is_skill_body, denial_kind, user_feedback FROM message ORDER BY id`,
        )
        .all() as Record<string, unknown>[],
    ),
    usage: db
      .prepare(
        `SELECT response_id, session_id, message_id, model, input_tokens, cache_read_tokens,
                cache_write_tokens, output_tokens, reasoning_tokens FROM usage ORDER BY response_id`,
      )
      .all() as Record<string, unknown>[],
  };
}

describe("ingest", () => {
  test("deduplicates usage on the message id, so tokens are not counted per content block", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      // The fixture writes one API response as two assistant lines, each
      // repeating the full usage. Summing per line overcounts.
      expect(db.prepare("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT sum(output_tokens) AS n FROM usage").get()).toEqual({ n: 50 });
    } finally {
      closeDb(db);
    }
  });

  test("joins the content blocks of one response into a single message", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      const row = db.prepare<{ text: string }, []>("SELECT text FROM message WHERE id = 'msg-1'").get();
      expect(row?.text).toBe("First half.\nSecond half.");
    } finally {
      closeDb(db);
    }
  });

  test("never stores tool results, file contents or thinking", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      const all = JSON.stringify(snapshot(db, root));
      expect(all).not.toContain("SECRET FILE CONTENTS");
      expect(all).not.toContain("SECRET REASONING");
    } finally {
      closeDb(db);
    }
  });

  test("re-syncing an unchanged corpus changes nothing", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      const before = snapshot(db, root);
      sync(db, env);
      sync(db, env);
      expect(snapshot(db, root)).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  test("reading a file in two chunks matches reading it once, even cut mid-line", () => {
    const lines = claudeTranscriptLines(SESSION);
    const cut = bytesThroughLine(lines, 2) + 40; // lands inside line 3

    const oneRoot = newRoot();
    const oneEnv = scratchEnv(oneRoot);
    writeClaudeTranscript(oneEnv, "-Users-x-code-demo", SESSION);
    const oneDb = run(oneEnv);
    const expected = snapshot(oneDb, oneRoot);
    closeDb(oneDb);

    const incRoot = newRoot();
    const incEnv = scratchEnv(incRoot);
    const path = join(incEnv.DIM_CLAUDE_PROJECTS as string, "-Users-x-code-demo", `${SESSION}.jsonl`);
    writePrefix(path, lines, cut);
    const incDb = run(incEnv);
    writePrefix(path, lines, fullBytes(lines));
    sync(incDb, incEnv);
    try {
      expect(snapshot(incDb, incRoot)).toEqual(expected);
    } finally {
      closeDb(incDb);
    }
  });

  test("a chunk boundary inside one response's content blocks matches reading it once", () => {
    const lines = claudeTranscriptLines(SESSION);
    // Exactly between the two lines that share message id msg-1.
    const cut = bytesThroughLine(lines, 2);

    const oneRoot = newRoot();
    const oneEnv = scratchEnv(oneRoot);
    writeClaudeTranscript(oneEnv, "-Users-x-code-demo", SESSION);
    const oneDb = run(oneEnv);
    const expected = snapshot(oneDb, oneRoot);
    closeDb(oneDb);

    const incRoot = newRoot();
    const incEnv = scratchEnv(incRoot);
    const path = join(incEnv.DIM_CLAUDE_PROJECTS as string, "-Users-x-code-demo", `${SESSION}.jsonl`);
    writePrefix(path, lines, cut);
    const incDb = run(incEnv);
    expect(
      incDb.prepare<{ text: string }, []>("SELECT text FROM message WHERE id = 'msg-1'").get()?.text,
    ).toBe("First half.");
    writePrefix(path, lines, fullBytes(lines));
    sync(incDb, incEnv);
    try {
      expect(snapshot(incDb, incRoot)).toEqual(expected);
    } finally {
      closeDb(incDb);
    }
  });

  test("a file that shrank is re-read from the start rather than left inconsistent", () => {
    const lines = claudeTranscriptLines(SESSION);

    const oneRoot = newRoot();
    const oneEnv = scratchEnv(oneRoot);
    writeClaudeTranscript(oneEnv, "-Users-x-code-demo", SESSION);
    const oneDb = run(oneEnv);
    const expected = snapshot(oneDb, oneRoot);
    closeDb(oneDb);

    const root = newRoot();
    const env = scratchEnv(root);
    const path = join(env.DIM_CLAUDE_PROJECTS as string, "-Users-x-code-demo", `${SESSION}.jsonl`);
    writePrefix(path, lines, fullBytes(lines));
    const db = run(env);
    writePrefix(path, lines, bytesThroughLine(lines, 1));
    sync(db, env);
    writePrefix(path, lines, fullBytes(lines));
    sync(db, env);
    try {
      expect(snapshot(db, root)).toEqual(expected);
    } finally {
      closeDb(db);
    }
  });

  test("a rollout Codex archives keeps one source row and is not read twice", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const from = writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      const before = snapshot(db, root);

      const to = join(env.DIM_CODEX_DIR as string, "archived_sessions", from.split("/").pop() as string);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      expect(sync(db, env).failures).toEqual([]);

      const after = snapshot(db, root);
      // Re-reading a moved file from byte zero would append its assistant text
      // a second time and leave a stale locator behind.
      expect(after.messages.map((m) => m.text)).toEqual(before.messages.map((m) => m.text));
      expect(db.prepare("SELECT count(*) AS n FROM source_file").get()).toEqual({ n: 1 });
      const src = db.prepare<{ src_file: string }, []>("SELECT src_file FROM message LIMIT 1").get();
      expect(src?.src_file).toContain("archived_sessions");
    } finally {
      closeDb(db);
    }
  });

  test("addresses a pre-August Codex message by thread and ordinal", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const legacy = codexRolloutLines(THREAD, { withIds: false });
    const path = join(env.DIM_CODEX_DIR as string, "sessions", `rollout-2026-02-05T19-43-37-${THREAD}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${legacy.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const db = run(env);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM message").get()).toEqual({ n: 3 });
    } finally {
      closeDb(db);
    }
  });

  test("links a subagent to the session that spawned it", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const agentDir = join(env.DIM_CLAUDE_PROJECTS as string, "-Users-x-code-demo", SESSION, "subagents");
    mkdirSync(agentDir, { recursive: true });
    const agentId = "a07d010a033dbe536";
    writeFileSync(
      join(agentDir, `agent-${agentId}.jsonl`),
      `${claudeTranscriptLines(SESSION)
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    writeFileSync(
      join(agentDir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: "Explore", toolUseId: "toolu-9", spawnDepth: 1 }),
    );
    const db = run(env);
    try {
      expect(db.prepare(`SELECT parent_id, agent_type FROM session WHERE id = '${agentId}'`).get()).toEqual({
        parent_id: SESSION,
        agent_type: "Explore",
      });
    } finally {
      closeDb(db);
    }
  });

  test("records a subagent whose parent transcript is gone, unlinked", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const agentDir = join(env.DIM_CLAUDE_PROJECTS as string, "-Users-x-code-demo", SESSION, "subagents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "agent-orphan1.jsonl"),
      `${claudeTranscriptLines(SESSION)
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    const db = openDb(dbPath(env));
    try {
      const report = sync(db, env);
      expect(report.orphanSubagents).toEqual(["orphan1"]);
      expect(report.failures).toEqual([]);
      expect(db.prepare("SELECT parent_id FROM session WHERE id = 'orphan1'").get()).toEqual({
        parent_id: null,
      });
    } finally {
      closeDb(db);
    }
  });
});
