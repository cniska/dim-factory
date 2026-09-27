import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { scratchEnv } from "./fixtures.test-support";
import { sync } from "./ingest-sync";
import { dbPath, type Env, grokDir } from "./paths";

const PARENT = "018f3b2a-7c3e-7b2a-8f1e-6c0b9a2d4e11";
const CHILD = "018f3b2a-7c3e-7b2a-8f1e-6c0b9a2d4e22";
const GONE = "018f3b2a-7c3e-7b2a-8f1e-6c0b9a2d4e33";
const ORPHAN = "018f3b2a-7c3e-7b2a-8f1e-6c0b9a2d4e44";
const AT = 1700000000000;
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-grok-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function event(update: unknown, eventId: string, ms = AT): unknown {
  return {
    timestamp: Math.floor(ms / 1000),
    method: "session/update",
    params: { sessionId: PARENT, update, _meta: { eventId, agentTimestampMs: ms } },
  };
}

function writeSession(
  env: Env,
  id: string,
  lines: unknown[],
  summary: Record<string, unknown>,
  group = "%2FUsers%2Fx%2Fcode%2Fdemo",
): string {
  const dir = join(grokDir(env), "sessions", group, id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "updates.jsonl");
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
  return path;
}

function parentSummary(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    info: { id: PARENT, cwd: "/Users/x/code/demo" },
    generated_title: "import grok",
    current_model_id: "grok-4.7",
    head_branch: "main",
    created_at: "2023-11-14T22:13:20.000Z",
    agent_name: "grok-build",
    ...extra,
  };
}

function seed(env: Env): string {
  const path = writeSession(
    env,
    PARENT,
    [
      event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } }, "user-1"),
      event(
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "THINKING_SECRET" } },
        "thought-1",
        AT + 1,
      ),
      event(
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "working" },
          _meta: { modelId: "grok-4.7" },
        },
        "agent-1",
        AT + 2,
      ),
      event(
        {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          rawInput: { target_file: "src/a.ts" },
          _meta: { "x.ai/tool": { name: "read_file" } },
        },
        "tool-1",
        AT + 3,
      ),
      event(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          output: "SECRET_RESULT",
        },
        "tool-1-done",
        AT + 4,
      ),
      event(
        {
          sessionUpdate: "tool_call",
          toolCallId: "call-2",
          rawInput: { command: "echo hi" },
          _meta: { "x.ai/tool": { name: "run_terminal_command" } },
        },
        "tool-2",
        AT + 5,
      ),
      event(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-2",
          status: "failed",
        },
        "tool-2-done",
        AT + 6,
      ),
    ],
    parentSummary(),
  );
  writeFileSync(path, "{\n", { flag: "a" });
  writeSession(
    env,
    CHILD,
    [event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "child" } }, "child-1")],
    {
      info: { id: CHILD, cwd: "/Users/x/code/demo" },
      parent_session_id: PARENT,
      agent_name: "explore",
      created_at: "2023-11-14T22:13:20.000Z",
    },
  );
  writeSession(
    env,
    ORPHAN,
    [event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "orphan" } }, "orphan-1")],
    {
      info: { id: ORPHAN, cwd: "/Users/x/code/demo" },
      parent_session_id: "missing-parent",
      created_at: "2023-11-14T22:13:20.000Z",
    },
  );
  const history = join(grokDir(env), "sessions", "%2FUsers%2Fx%2Fcode%2Fdemo", "prompt_history.jsonl");
  writeFileSync(
    history,
    `${JSON.stringify({
      timestamp: "2023-11-14T22:13:21.000Z",
      session_id: GONE,
      prompt: "only in history",
      is_bash: false,
    })}\n`,
  );
  return path;
}

describe("grok sessions", () => {
  test("keeps prompts and tool names, and drops thinking and tool results", () => {
    const env = scratchEnv(newRoot());
    const path = seed(env);
    const db = openDb(dbPath(env));
    try {
      const report = sync(db, env);
      expect(report.sources.find((source) => source.tool === "grok")).toEqual({ tool: "grok", files: 3 });
      expect(report.dropped).toEqual([{ path, lines: [8] }]);
      expect(report.orphanSubagents).toEqual([ORPHAN]);
      expect(
        db
          .prepare(
            "SELECT id, tool, cwd, title, last_model, git_branch, agent_type, parent_id FROM session WHERE id = ?",
          )
          .get(PARENT),
      ).toEqual({
        id: PARENT,
        tool: "grok",
        cwd: "/Users/x/code/demo",
        title: "import grok",
        last_model: "grok-4.7",
        git_branch: "main",
        agent_type: "grok-build",
        parent_id: null,
      });
      expect(
        db.prepare("SELECT role, text FROM message WHERE session_id = ? ORDER BY ts").all(PARENT),
      ).toEqual([
        { role: "user", text: "hello" },
        { role: "assistant", text: "working" },
      ]);
      expect(
        db
          .prepare(
            "SELECT id, tool_name, file_path, command, is_error FROM tool_call WHERE session_id = ? ORDER BY id",
          )
          .all(PARENT),
      ).toEqual([
        { id: "call-1", tool_name: "read_file", file_path: "src/a.ts", command: null, is_error: null },
        { id: "call-2", tool_name: "run_terminal_command", file_path: null, command: "echo hi", is_error: 1 },
      ]);
      expect(db.prepare("SELECT parent_id, agent_type FROM session WHERE id = ?").get(CHILD)).toEqual({
        parent_id: PARENT,
        agent_type: "explore",
      });
      expect(db.prepare("SELECT parent_id FROM session WHERE id = ?").get(ORPHAN)).toEqual({
        parent_id: null,
      });
      const stored =
        JSON.stringify(db.prepare("SELECT text FROM message").all()) +
        JSON.stringify(db.prepare("SELECT extra, command FROM tool_call").all());
      expect(stored).not.toContain("THINKING_SECRET");
      expect(stored).not.toContain("SECRET_RESULT");
      expect(db.prepare("SELECT tool, text, project FROM orphan_prompt").get()).toEqual({
        tool: "grok",
        text: "only in history",
        project: "/Users/x/code/demo",
      });
    } finally {
      closeDb(db);
    }
  });

  test("reading the same files again changes nothing", () => {
    const env = scratchEnv(newRoot());
    seed(env);
    const db = openDb(dbPath(env));
    try {
      sync(db, env);
      const again = sync(db, env);
      expect(again.filesRead).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM message").get()).toEqual({ n: 4 });
    } finally {
      closeDb(db);
    }
  });

  test("does not read another home when GROK_HOME points elsewhere", () => {
    const env = scratchEnv(newRoot());
    const db = openDb(dbPath(env));
    try {
      const report = sync(db, env);
      expect(report.sources.find((source) => source.tool === "grok")).toEqual({ tool: "grok", files: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM session WHERE tool = 'grok'").get()).toEqual({ n: 0 });
    } finally {
      closeDb(db);
    }
  });
});
