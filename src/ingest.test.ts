import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { openDb } from "./db";
import {
  bytesThroughLine,
  claudeTranscriptLines,
  codexRolloutLines,
  fullBytes,
  scratchEnv,
  withoutTimestamp,
  writeClaudeTranscript,
  writeCodexRollout,
  writePrefix,
} from "./fixtures.test-support";
import { sync } from "./ingest-sync";
import { claudeProjectsDir, codexDir, dbPath, type Env, workerSessionsDir } from "./paths";

const SESSION = "11111111-2222-3333-4444-555555555555";
const THREAD = "01a0a651-086e-7150-8650-cef0f4025a58";
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(env: Env): Database {
  const db = openDb(dbPath(env));
  sync(db, env);
  return db;
}

function snapshot(db: Database, root: string) {
  const strip = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
    rows.map((r) => ({
      ...r,
      src_file: typeof r.src_file === "string" ? r.src_file.replace(root, "") : r.src_file,
    }));
  return {
    sessions: db
      .prepare<Record<string, unknown>, []>(
        `SELECT id, tool, parent_id, agent_type, cwd, project, git_branch, cli_version, entrypoint,
                started_at, last_seen_at, title FROM session ORDER BY id`,
      )
      .all(),
    messages: strip(
      db
        .prepare<Record<string, unknown>, []>(
          `SELECT id, session_id, role, model, ts, text, text_chars, src_file, src_line,
                  is_meta, is_skill_body, denial_kind, user_feedback FROM message ORDER BY id`,
        )
        .all(),
    ),
    usage: db
      .prepare<Record<string, unknown>, []>(
        `SELECT response_id, session_id, message_id, model, input_tokens, cache_read_tokens,
                cache_write_tokens, output_tokens FROM usage ORDER BY response_id`,
      )
      .all(),
    turns: db
      .prepare<Record<string, unknown>, []>(
        `SELECT session_id, turn_id, ts_start, ts_end, duration_ms, message_count, status, model,
                time_to_first_token_ms FROM turn ORDER BY session_id, turn_id`,
      )
      .all(),
  };
}

describe("ingest", () => {
  test("deduplicates usage on the message id, so tokens are not counted per content block", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT sum(output_tokens) AS n FROM usage").get()).toEqual({ n: 50 });
    } finally {
      db.close();
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
      db.close();
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
      db.close();
    }
  });

  test("records turn timing from both tools", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      expect(
        db
          .prepare(
            "SELECT turn_id, duration_ms, message_count, status FROM turn WHERE turn_id = 'turn-1' AND session_id = ?",
          )
          .get(SESSION),
      ).toEqual({
        turn_id: "turn-1",
        duration_ms: 7193,
        message_count: 13,
        status: "completed",
      });
      expect(
        db
          .prepare("SELECT status, duration_ms, model FROM turn WHERE session_id = ? ORDER BY turn_id")
          .all(THREAD),
      ).toEqual([
        { status: "completed", duration_ms: 151652, model: "gpt-5.6-luna" },
        { status: "interrupted", duration_ms: 8128, model: "gpt-5.6-sol" },
      ]);
    } finally {
      db.close();
    }
  });

  test("keeps the assistant reply that rides along with a completed Codex turn out of the database", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      const dump = db
        .prepare<{ t: string }, []>("SELECT group_concat(coalesce(text,'')) AS t FROM message")
        .get();
      expect(JSON.stringify(snapshot(db, root))).not.toContain("SECRET AGENT MESSAGE");
      expect(dump?.t).not.toContain("SECRET AGENT MESSAGE");
    } finally {
      db.close();
    }
  });

  test("joins a tool call to its result, which arrive as separate records", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      expect(
        db
          .prepare(
            "SELECT tool_name, command, is_error, ts_call IS NOT NULL AS called, ts_result IS NOT NULL AS resulted, result_bytes FROM tool_call WHERE id = 'toolu-1'",
          )
          .get(),
      ).toEqual({
        tool_name: "Bash",
        command: "ls",
        is_error: 0,
        called: 1,
        resulted: 1,
        result_bytes: 40,
      });
    } finally {
      db.close();
    }
  });

  test("measures what a tool returned without storing any of it", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      const dump = JSON.stringify(db.prepare<Record<string, unknown>, []>("SELECT * FROM tool_call").all());
      expect(dump).not.toContain("SECRET FILE CONTENTS");
      expect(
        db.prepare("SELECT result_bytes, src_line_result FROM tool_call WHERE id = 'toolu-1'").get(),
      ).toMatchObject({ result_bytes: 40 });
    } finally {
      db.close();
    }
  });

  test("records Codex exit codes and durations, which Claude does not report", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeCodexRollout(env, "sessions", THREAD);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = run(env);
    try {
      const claude = db
        .prepare("SELECT count(*) AS n FROM tool_call WHERE session_id = ? AND exit_code IS NOT NULL")
        .get(SESSION);
      expect(claude).toEqual({ n: 0 });
    } finally {
      db.close();
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
      db.close();
    }
  });

  test("reading a file in two chunks matches reading it once, even cut mid-line", () => {
    const lines = claudeTranscriptLines(SESSION);
    const cut = bytesThroughLine(lines, 2) + 40;

    const oneRoot = newRoot();
    const oneEnv = scratchEnv(oneRoot);
    writeClaudeTranscript(oneEnv, "-Users-x-code-demo", SESSION);
    const oneDb = run(oneEnv);
    const expected = snapshot(oneDb, oneRoot);
    oneDb.close();

    const incRoot = newRoot();
    const incEnv = scratchEnv(incRoot);
    const path = join(claudeProjectsDir(incEnv), "-Users-x-code-demo", `${SESSION}.jsonl`);
    writePrefix(path, lines, cut);
    const incDb = run(incEnv);
    writePrefix(path, lines, fullBytes(lines));
    sync(incDb, incEnv);
    try {
      expect(snapshot(incDb, incRoot)).toEqual(expected);
    } finally {
      incDb.close();
    }
  });

  test("a chunk boundary inside one response's content blocks matches reading it once", () => {
    const lines = claudeTranscriptLines(SESSION);
    const cut = bytesThroughLine(lines, 2);

    const oneRoot = newRoot();
    const oneEnv = scratchEnv(oneRoot);
    writeClaudeTranscript(oneEnv, "-Users-x-code-demo", SESSION);
    const oneDb = run(oneEnv);
    const expected = snapshot(oneDb, oneRoot);
    oneDb.close();

    const incRoot = newRoot();
    const incEnv = scratchEnv(incRoot);
    const path = join(claudeProjectsDir(incEnv), "-Users-x-code-demo", `${SESSION}.jsonl`);
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
      incDb.close();
    }
  });

  test("a file that shrank is re-read from the start rather than left inconsistent", () => {
    const lines = claudeTranscriptLines(SESSION);

    const oneRoot = newRoot();
    const oneEnv = scratchEnv(oneRoot);
    writeClaudeTranscript(oneEnv, "-Users-x-code-demo", SESSION);
    const oneDb = run(oneEnv);
    const expected = snapshot(oneDb, oneRoot);
    oneDb.close();

    const root = newRoot();
    const env = scratchEnv(root);
    const path = join(claudeProjectsDir(env), "-Users-x-code-demo", `${SESSION}.jsonl`);
    writePrefix(path, lines, fullBytes(lines));
    const db = run(env);
    writePrefix(path, lines, bytesThroughLine(lines, 1));
    sync(db, env);
    writePrefix(path, lines, fullBytes(lines));
    sync(db, env);
    try {
      expect(snapshot(db, root)).toEqual(expected);
    } finally {
      db.close();
    }
  });

  test("a rollout Codex archives keeps one source row and is not read twice", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const from = writeCodexRollout(env, "sessions", THREAD);
    const db = run(env);
    try {
      const before = snapshot(db, root);

      const to = join(codexDir(env), "archived_sessions", basename(from));
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      expect(sync(db, env).failures).toEqual([]);

      const after = snapshot(db, root);
      expect(after.messages.map((m) => m.text)).toEqual(before.messages.map((m) => m.text));
      expect(db.prepare("SELECT count(*) AS n FROM source_file").get()).toEqual({ n: 1 });
      const src = db.prepare<{ src_file: string }, []>("SELECT src_file FROM message LIMIT 1").get();
      expect(src?.src_file).toContain("archived_sessions");
    } finally {
      db.close();
    }
  });

  test("titles a Codex session from the thread Codex keeps, while Codex is not running", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeCodexRollout(env, "sessions", THREAD);
    const statePath = join(codexDir(env), "state_5.sqlite");
    const state = new Database(statePath);
    state.run("PRAGMA journal_mode = WAL");
    state.run("CREATE TABLE threads (id TEXT, title TEXT)");
    state.run("INSERT INTO threads VALUES (?, ?)", [THREAD, "Read the slice"]);
    state.close();
    rmSync(`${statePath}-wal`, { force: true });
    rmSync(`${statePath}-shm`, { force: true });

    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([]);
      expect(db.prepare("SELECT title FROM session WHERE id = ?").get(THREAD)).toEqual({
        title: "Read the slice",
      });
    } finally {
      db.close();
    }
  });

  test("names a Codex thread store it cannot read as a failure and still reads the rollouts", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeCodexRollout(env, "sessions", THREAD);
    const statePath = join(codexDir(env), "state_5.sqlite");
    const state = new Database(statePath);
    state.run("CREATE TABLE threads (id TEXT, name TEXT)");
    state.close();

    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([
        { path: statePath, error: expect.stringContaining("no such column: title") },
      ]);
      expect(db.prepare("SELECT count(*) AS n FROM session WHERE id = ?").get(THREAD)).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  test("reads past a line that is not JSON and names it in the report", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const path = join(claudeProjectsDir(env), "-Users-x-code-demo", `${SESSION}.jsonl`);
    const good = claudeTranscriptLines(SESSION).map((l) => JSON.stringify(l));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${[good[0], "{ truncated", ...good.slice(1)].join("\n")}\n`);

    const db = openDb(dbPath(env));
    try {
      const report = sync(db, env);
      expect(report.dropped).toEqual([{ path, lines: [2] }]);
      expect(report.failures).toEqual([]);
      expect(db.prepare("SELECT count(*) AS n FROM message").get()).not.toEqual({ n: 0 });
      expect(sync(db, env).dropped).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("refuses a transcript line with no timestamp, keeping the message's real time", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const path = join(claudeProjectsDir(env), "-Users-x-code-demo", `${SESSION}.jsonl`);
    const lines = claudeTranscriptLines(SESSION).map((line, index) => {
      if (index !== 3) return JSON.stringify(line);
      return withoutTimestamp(line);
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join("\n")}\n`);

    const db = openDb(dbPath(env));
    try {
      const report = sync(db, env);
      expect(db.prepare("SELECT ts FROM message WHERE id = 'msg-1'").get()).toEqual({
        ts: "2026-09-16T10:02:00.000Z",
      });
      expect(report.dropped).toEqual([{ path, lines: [4] }]);
      expect(db.prepare("SELECT count(*) AS n FROM message WHERE ts = ''").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("addresses a pre-August Codex message by thread and line", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const legacy = codexRolloutLines(THREAD, { withIds: false });
    const path = join(codexDir(env), "sessions", `rollout-2026-02-05T19-43-37-${THREAD}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${legacy.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const db = run(env);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM message").get()).toEqual({ n: 3 });
    } finally {
      db.close();
    }
  });

  test("links a subagent to the session that spawned it", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const agentDir = join(claudeProjectsDir(env), "-Users-x-code-demo", SESSION, "subagents");
    mkdirSync(agentDir, { recursive: true });
    const agentId = "a1111111111111111";
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
      expect(
        db.prepare("SELECT parent_id, agent_type FROM session WHERE id = ?").get(`${agentId}@${SESSION}`),
      ).toEqual({ parent_id: SESSION, agent_type: "Explore" });
    } finally {
      db.close();
    }
  });

  test("ignores a subagent meta file whose agentType is not a string", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const agentDir = join(claudeProjectsDir(env), "-Users-x-code-demo", SESSION, "subagents");
    mkdirSync(agentDir, { recursive: true });
    const agentId = "a1111111111111111";
    writeFileSync(
      join(agentDir, `agent-${agentId}.jsonl`),
      `${claudeTranscriptLines(SESSION)
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    writeFileSync(join(agentDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 5 }));
    const db = run(env);
    try {
      expect(
        db.prepare("SELECT parent_id, agent_type FROM session WHERE id = ?").get(`${agentId}@${SESSION}`),
      ).toEqual({ parent_id: SESSION, agent_type: null });
    } finally {
      db.close();
    }
  });

  test("re-reads a shrunk transcript whose session spawned a subagent, keeping the subagent's link", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const path = writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const agentDir = join(claudeProjectsDir(env), "-Users-x-code-demo", SESSION, "subagents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "agent-a1111111111111111.jsonl"),
      `${claudeTranscriptLines(SESSION)
        .map((l) => JSON.stringify(l).replace(/"(msg|toolu|u|a)-/g, '"agent-$1-'))
        .join("\n")}\n`,
    );
    run(env).close();
    const kept = claudeTranscriptLines(SESSION).slice(0, 2);
    writeFileSync(path, `${kept.map((l) => JSON.stringify(l)).join("\n")}\n`);

    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([]);
      expect(sync(db, env).failures).toEqual([]);
      const reread = db
        .prepare<{ n: number }, [string]>("SELECT count(*) AS n FROM message WHERE session_id = ?")
        .get(SESSION)?.n;
      const fresh = openDb(join(root, "fresh.db"));
      const expected = (() => {
        const other = scratchEnv(join(root, "fresh"));
        writeFileSync(
          writeClaudeTranscript(other, "-Users-x-code-demo", SESSION),
          `${kept.map((l) => JSON.stringify(l)).join("\n")}\n`,
        );
        sync(fresh, other);
        return fresh
          .prepare<{ n: number }, [string]>("SELECT count(*) AS n FROM message WHERE session_id = ?")
          .get(SESSION)?.n;
      })();
      fresh.close();
      expect(reread).toBe(expected);
      expect(
        db.prepare("SELECT parent_id FROM session WHERE id = ?").get(`a1111111111111111@${SESSION}`),
      ).toEqual({ parent_id: SESSION });
    } finally {
      db.close();
    }
  });

  test("keeps two subagents that share an agent id apart", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const other = "99999999-8888-7777-6666-555555555555";
    for (const parent of [SESSION, other]) {
      writeClaudeTranscript(env, "-Users-x-code-demo", parent);
      const dir = join(claudeProjectsDir(env), "-Users-x-code-demo", parent, "subagents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "agent-shared.jsonl"),
        `${claudeTranscriptLines(parent)
          .map((l) => JSON.stringify(l))
          .join("\n")}\n`,
      );
    }
    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).dropped).toEqual([]);
      const rows = db
        .prepare<{ id: string; parent_id: string }, []>(
          "SELECT id, parent_id FROM session WHERE id LIKE 'shared@%' ORDER BY id",
        )
        .all();
      expect(rows).toEqual([
        { id: `shared@${SESSION}`, parent_id: SESSION },
        { id: `shared@${other}`, parent_id: other },
      ]);
      expect(db.prepare("SELECT count(*) AS n FROM source_file WHERE kind = 'subagent'").get()).toEqual({
        n: 2,
      });
    } finally {
      db.close();
    }
  });

  test("records a subagent whose parent transcript is gone, unlinked", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    const agentDir = join(claudeProjectsDir(env), "-Users-x-code-demo", SESSION, "subagents");
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
      const id = `orphan1@${SESSION}`;
      expect(report.orphanSubagents).toEqual([id]);
      expect(report.failures).toEqual([]);
      expect(db.prepare("SELECT parent_id FROM session WHERE id = ?").get(id)).toEqual({
        parent_id: null,
      });
    } finally {
      db.close();
    }
  });
});

describe("skill loads", () => {
  const COPY = "66666666-7777-8888-9999-000000000000";
  const at = (n: number) => `2026-09-20T10:0${n}:00.000Z`;
  const base = { sessionId: SESSION, cwd: "/Users/x/code/demo", isSidechain: false };
  const bodyText = (path: string) => `Base directory for this skill: ${path}\n\n# Body`;

  const skillCall = {
    ...base,
    type: "assistant",
    uuid: "a-skill",
    timestamp: at(1),
    message: {
      id: "msg-skill",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "tool_use", id: "toolu-skill", name: "Skill", input: { skill: "dim:dim-plan" } }],
    },
  };
  const skillBody = {
    ...base,
    type: "user",
    uuid: "u-skill-body",
    parentUuid: "a-skill",
    timestamp: at(2),
    isMeta: true,
    sourceToolUseID: "toolu-skill",
    message: { role: "user", content: bodyText("/Users/x/code/dim-factory/plugin/skills/dim-plan") },
  };
  const typed = (uuid: string, command: string) => ({
    ...base,
    type: "user",
    uuid,
    timestamp: at(3),
    message: { role: "user", content: `<command-name>/${command}</command-name>` },
  });
  const typedBody = (uuid: string, parentUuid: string, path: string) => ({
    ...base,
    type: "user",
    uuid,
    parentUuid,
    timestamp: at(4),
    isMeta: true,
    message: { role: "user", content: bodyText(path) },
  });

  function writeTranscript(env: Env, sessionId: string, lines: unknown[]): string {
    const path = join(claudeProjectsDir(env), "-Users-x-code-demo", `${sessionId}.jsonl`);
    writePrefix(path, lines, fullBytes(lines));
    return path;
  }

  function skillLoads(db: Database) {
    return db
      .prepare(
        `SELECT session_id, message_id, ts, model, skill_name, how, body_chars, skill_path
         FROM skill_load ORDER BY session_id, ts`,
      )
      .all();
  }

  const calledLoad = {
    session_id: SESSION,
    message_id: "msg-skill",
    ts: at(1),
    model: "claude-opus-5-5",
    skill_name: "dim:dim-plan",
    how: "model",
    body_chars: 6,
    skill_path: "/Users/x/code/dim-factory/plugin/skills/dim-plan",
  };

  test("stores a Skill call and the body it injected as one load", () => {
    const env = scratchEnv(newRoot());
    writeTranscript(env, SESSION, [skillCall, skillBody]);
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([calledLoad]);
    } finally {
      db.close();
    }
  });

  test("stores one load when the body arrives in a later sync than its call", () => {
    const env = scratchEnv(newRoot());
    const lines = [skillCall, skillBody];
    const path = writeTranscript(env, SESSION, lines);
    writePrefix(path, lines, bytesThroughLine(lines, 0));
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([{ ...calledLoad, body_chars: null, skill_path: null }]);
      writePrefix(path, lines, fullBytes(lines));
      sync(db, env);
      expect(skillLoads(db)).toEqual([calledLoad]);
    } finally {
      db.close();
    }
  });

  test("stores a typed skill whose body arrives in a later sync than its command", () => {
    const env = scratchEnv(newRoot());
    const lines = [
      typed("u-plugin", "dim:dim-plan"),
      typedBody("u-plugin-body", "u-plugin", "/Users/x/code/dim-factory/plugin/skills/dim-plan"),
    ];
    const path = writeTranscript(env, SESSION, lines);
    writePrefix(path, lines, bytesThroughLine(lines, 0));
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([]);
      writePrefix(path, lines, fullBytes(lines));
      sync(db, env);
      expect(skillLoads(db)).toEqual([
        {
          session_id: SESSION,
          message_id: "u-plugin",
          ts: at(3),
          model: null,
          skill_name: "dim:dim-plan",
          how: "user",
          body_chars: 6,
          skill_path: "/Users/x/code/dim-factory/plugin/skills/dim-plan",
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("stores a typed skill and its body as one load the user chose", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    mkdirSync(join(root, "skills", "review"), { recursive: true });
    writeFileSync(join(root, "skills", "review", "SKILL.md"), "# Review");
    writeTranscript(env, SESSION, [
      typed("u-typed", "review"),
      typedBody("u-typed-body", "u-typed", "/Users/x/.claude/skills/review"),
    ]);
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([
        {
          session_id: SESSION,
          message_id: "u-typed",
          ts: at(3),
          model: null,
          skill_name: "review",
          how: "user",
          body_chars: 6,
          skill_path: "/Users/x/.claude/skills/review",
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("keeps the body's name when the typed command names a different skill", () => {
    const env = scratchEnv(newRoot());
    writeTranscript(env, SESSION, [
      typed("u-other", "dim:other"),
      typedBody("u-other-body", "u-other", "/Users/x/code/dim-factory/plugin/skills/dim-plan"),
    ]);
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([
        expect.objectContaining({ message_id: "u-other", skill_name: "dim-plan" }),
      ]);
    } finally {
      db.close();
    }
  });

  test("stores a typed plugin skill the command form misses as one load the user chose", () => {
    const env = scratchEnv(newRoot());
    writeTranscript(env, SESSION, [
      typed("u-plugin", "dim:dim-plan"),
      typedBody("u-plugin-body", "u-plugin", "/Users/x/code/dim-factory/plugin/skills/dim-plan"),
    ]);
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([
        {
          session_id: SESSION,
          message_id: "u-plugin",
          ts: at(3),
          model: null,
          skill_name: "dim:dim-plan",
          how: "user",
          body_chars: 6,
          skill_path: "/Users/x/code/dim-factory/plugin/skills/dim-plan",
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("stores a Skill call copied into a second session file once in each session", () => {
    const env = scratchEnv(newRoot());
    writeTranscript(env, SESSION, [skillCall, skillBody]);
    writeTranscript(env, COPY, [skillCall, skillBody]);
    const db = run(env);
    try {
      expect(skillLoads(db)).toEqual([calledLoad, { ...calledLoad, session_id: COPY }]);
    } finally {
      db.close();
    }
  });

  test("stores nothing for a body whose Skill call is missing", () => {
    const env = scratchEnv(newRoot());
    writeClaudeTranscript(env, "-Users-x-code-demo", SESSION);
    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([]);
      expect(skillLoads(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("stores nothing for a typed body whose command line was dropped or that names no parent", () => {
    const env = scratchEnv(newRoot());
    const { timestamp: _, ...untimed } = typed("u-untimed", "dim:dim-plan");
    const { parentUuid: __, ...parentless } = typedBody(
      "u-parentless-body",
      "",
      "/Users/x/.claude/skills/review",
    );
    writeTranscript(env, SESSION, [
      untimed,
      typedBody("u-untimed-body", "u-untimed", "/Users/x/code/dim-factory/plugin/skills/dim-plan"),
      parentless,
    ]);
    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([]);
      expect(skillLoads(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("stores nothing for a body pointing at a call that names no skill or is not a Skill call", () => {
    const env = scratchEnv(newRoot());
    const call = (id: string, name: string, input: unknown) => ({
      ...skillCall,
      uuid: `a-${id}`,
      message: { ...skillCall.message, id: `msg-${id}`, content: [{ type: "tool_use", id, name, input }] },
    });
    writeTranscript(env, SESSION, [
      call("toolu-unnamed", "Skill", {}),
      { ...skillBody, uuid: "u-unnamed-body", sourceToolUseID: "toolu-unnamed" },
      call("toolu-agent", "Agent", { skill: "dim:dim-plan" }),
      { ...skillBody, uuid: "u-agent-body", sourceToolUseID: "toolu-agent" },
    ]);
    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).failures).toEqual([]);
      expect(skillLoads(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("stores nothing for a body whose Skill call row has no call time", () => {
    const env = scratchEnv(newRoot());
    const result = {
      ...base,
      type: "user",
      uuid: "u-skill-result",
      timestamp: at(1),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu-skill", content: "Launching" }],
      },
    };
    const lines = [result, skillBody];
    const path = writeTranscript(env, SESSION, lines);
    writePrefix(path, lines, bytesThroughLine(lines, 0));
    const db = run(env);
    try {
      db.run(
        "UPDATE tool_call SET tool_name = 'Skill', skill_name = 'dim:dim-plan' WHERE id = 'toolu-skill'",
      );
      expect(db.prepare("SELECT ts_call FROM tool_call WHERE id = 'toolu-skill'").get()).toEqual({
        ts_call: null,
      });
      writePrefix(path, lines, fullBytes(lines));
      expect(sync(db, env).failures).toEqual([]);
      expect(skillLoads(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("worker transcript copies", () => {
  const WORKER = "latch-7";
  const base = { sessionId: SESSION, cwd: "/Users/x/data/workspaces/acme/widgets/ord1", isSidechain: false };
  const at = (n: number) => `2026-09-20T10:0${n}:00.000Z`;
  const turn = (n: number, text: string, content: unknown[]) => [
    {
      ...base,
      type: "user",
      uuid: `u-${n}`,
      timestamp: at(n),
      promptSource: "typed",
      message: { role: "user", content: text },
    },
    {
      ...base,
      type: "assistant",
      uuid: `a-${n}`,
      timestamp: at(n + 1),
      message: { id: `msg-${n}`, role: "assistant", model: "claude-opus-5-5", content },
    },
  ];
  const lines = [
    ...turn(1, "read the notes", [
      { type: "tool_use", id: "toolu-read", name: "Read", input: { file_path: "/Users/x/data/notes.md" } },
      { type: "tool_use", id: "toolu-skill", name: "Skill", input: { skill: "dim:dim-plan" } },
    ]),
    {
      ...base,
      type: "user",
      uuid: "u-body",
      parentUuid: "a-1",
      timestamp: at(3),
      isMeta: true,
      sourceToolUseID: "toolu-skill",
      message: { role: "user", content: "Base directory for this skill: /Users/x/skills/dim-plan\n\n# Body" },
    },
    ...turn(4, "now the next step", []),
  ];

  function writeCopy(env: Env, content: unknown[]): string {
    const path = join(workerSessionsDir(WORKER, env), `${SESSION}.jsonl`);
    writePrefix(path, content, fullBytes(content));
    return path;
  }

  function writeProjects(env: Env, content: unknown[]): string {
    const path = join(claudeProjectsDir(env), "-Users-x-data-workspaces-acme", `${SESSION}.jsonl`);
    writePrefix(path, content, fullBytes(content));
    return path;
  }

  function attribute(db: Database): void {
    db.run(
      "INSERT INTO worker (name, role, project, order_id) VALUES (?, 'builder', 'acme/widgets', 'ord1')",
      [WORKER],
    );
    db.run(
      "INSERT INTO worker_session (id, worker, harness, pid, pid_started_at) VALUES (?, ?, 'claude', 1, 'x')",
      [SESSION, WORKER],
    );
  }

  const messageTexts = (db: Database) =>
    db.prepare("SELECT text FROM message WHERE role = 'user' ORDER BY ts").all();

  test("records a copied worker session with its tool calls and skill load, attributed to its worker", () => {
    const env = scratchEnv(newRoot());
    writeCopy(env, lines);
    const db = run(env);
    try {
      attribute(db);
      expect(
        db
          .prepare(
            `SELECT s.id, w.worker FROM session s JOIN worker_session w USING (id) WHERE s.tool = 'claude'`,
          )
          .all(),
      ).toEqual([{ id: SESSION, worker: WORKER }]);
      expect(db.prepare("SELECT tool_name, file_path FROM tool_call WHERE id = 'toolu-read'").all()).toEqual([
        { tool_name: "Read", file_path: "/Users/x/data/notes.md" },
      ]);
      expect(db.prepare("SELECT session_id, skill_name FROM skill_load").all()).toEqual([
        { session_id: SESSION, skill_name: "dim:dim-plan" },
      ]);
    } finally {
      db.close();
    }
  });

  test("reads a session id found in both places from the projects file alone", () => {
    const env = scratchEnv(newRoot());
    const projects = writeProjects(env, lines);
    writeCopy(env, lines.slice(0, 2));
    const db = run(env);
    try {
      const before = messageTexts(db);
      expect(before).toHaveLength(3);
      const again = sync(db, env);
      expect(again.filesRead).toBe(0);
      expect(again.sources[0]).toEqual({ tool: "claude", files: 1 });
      expect(db.prepare("SELECT path FROM source_file").all()).toEqual([{ path: projects }]);
      expect(messageTexts(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  test("reads the copy once the projects file is gone, holding each message once", () => {
    const env = scratchEnv(newRoot());
    const projects = writeProjects(env, lines);
    const copy = writeCopy(env, lines);
    const db = run(env);
    try {
      const before = messageTexts(db);
      rmSync(projects);
      const after = sync(db, env);
      expect(after.failures).toEqual([]);
      expect(db.prepare("SELECT path FROM source_file").all()).toEqual([{ path: copy }]);
      expect(messageTexts(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  test("follows a session to the projects file when it appears after the copy was read", () => {
    const env = scratchEnv(newRoot());
    writeCopy(env, lines.slice(0, 2));
    const db = run(env);
    try {
      const projects = writeProjects(env, lines);
      expect(sync(db, env).failures).toEqual([]);
      expect(db.prepare("SELECT path FROM source_file").all()).toEqual([{ path: projects }]);
      expect(messageTexts(db)).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  test("takes the session id from the copy's file name, which is the id the worker is recorded under", () => {
    const env = scratchEnv(newRoot());
    writeCopy(
      env,
      lines.map((line) => ({ ...line, sessionId: "99999999-8888-7777-6666-555555555555" })),
    );
    const db = run(env);
    try {
      attribute(db);
      expect(db.prepare("SELECT id FROM session WHERE tool = 'claude'").all()).toEqual([{ id: SESSION }]);
      expect(db.prepare("SELECT w.worker FROM session s JOIN worker_session w USING (id)").all()).toEqual([
        { worker: WORKER },
      ]);
    } finally {
      db.close();
    }
  });

  const AGENT = "a1111111111111111";
  const subLines = [
    ...turn(5, "look around", [
      { type: "tool_use", id: "toolu-sub", name: "Read", input: { file_path: "/Users/x/data/sub.md" } },
    ]),
  ].map((line) => ({ ...line, isSidechain: true }));

  function writeSubagent(root: string, content: unknown[]): string {
    const path = join(root, "subagents", `agent-${AGENT}.jsonl`);
    writePrefix(path, content, fullBytes(content));
    writeFileSync(
      join(root, "subagents", `agent-${AGENT}.meta.json`),
      JSON.stringify({ agentType: "Explore" }),
    );
    return path;
  }

  const copiedSubagent = (env: Env, content: unknown[]) =>
    writeSubagent(join(workerSessionsDir(WORKER, env), SESSION), content);

  const projectsSubagent = (env: Env, content: unknown[]) =>
    writeSubagent(join(claudeProjectsDir(env), "-Users-x-data-workspaces-acme", SESSION), content);

  test("records a copied subagent under its parent, its tool call joined to the parent's worker", () => {
    const env = scratchEnv(newRoot());
    writeCopy(env, lines);
    copiedSubagent(env, subLines);
    const db = run(env);
    try {
      attribute(db);
      expect(
        db.prepare("SELECT id, parent_id, agent_type FROM session WHERE parent_id IS NOT NULL").all(),
      ).toEqual([{ id: `${AGENT}@${SESSION}`, parent_id: SESSION, agent_type: "Explore" }]);
      expect(
        db
          .prepare(
            `SELECT w.worker FROM tool_call t JOIN session s ON s.id = t.session_id
             JOIN worker_session w ON w.id = s.parent_id WHERE t.id = 'toolu-sub'`,
          )
          .all(),
      ).toEqual([{ worker: WORKER }]);
    } finally {
      db.close();
    }
  });

  test("reads a subagent found in both places from the projects file alone", () => {
    const env = scratchEnv(newRoot());
    writeProjects(env, lines);
    const projects = projectsSubagent(env, subLines);
    writeCopy(env, lines);
    copiedSubagent(env, subLines.slice(0, 1));
    const db = run(env);
    try {
      expect(db.prepare("SELECT path FROM source_file WHERE kind = 'subagent'").all()).toEqual([
        { path: projects },
      ]);
    } finally {
      db.close();
    }
  });

  test("reads the copied subagent once the projects file is gone, holding each message once", () => {
    const env = scratchEnv(newRoot());
    writeCopy(env, lines);
    const projects = projectsSubagent(env, subLines);
    const copy = copiedSubagent(env, subLines);
    const db = run(env);
    try {
      const before = db.prepare("SELECT text FROM message WHERE session_id = ?").all(`${AGENT}@${SESSION}`);
      expect(before).toHaveLength(2);
      rmSync(projects);
      expect(sync(db, env).failures).toEqual([]);
      expect(db.prepare("SELECT path FROM source_file WHERE kind = 'subagent'").all()).toEqual([
        { path: copy },
      ]);
      expect(db.prepare("SELECT text FROM message WHERE session_id = ?").all(`${AGENT}@${SESSION}`)).toEqual(
        before,
      );
    } finally {
      db.close();
    }
  });
});
