import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDb, openDb } from "./db";
import { scratchEnv, writeClaudeTranscript } from "./fixtures.test-support";
import { claudeHistoryPath, codexHistoryPath, ingestHistory } from "./history";
import { dbPath, type Env } from "./paths";
import { sync } from "./sync";

const LIVE = "11111111-2222-3333-4444-555555555555";
const GONE = "99999999-8888-7777-6666-555555555555";
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-history-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function writeHistory(path: string, lines: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

function seed(env: Env): void {
  writeClaudeTranscript(env, "-Users-x-code-demo", LIVE);
  writeHistory(claudeHistoryPath(env), [
    { display: "still here", timestamp: 1772583590087, project: "/Users/x/code/demo", sessionId: LIVE },
    { display: "only in history", timestamp: 1772583590088, project: "/Users/x/code/demo", sessionId: GONE },
  ]);
  writeHistory(codexHistoryPath(env), [{ session_id: GONE, ts: 1770313422, text: "codex prompt" }]);
}

describe("history", () => {
  test("keeps only the prompts whose session has no transcript", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    seed(env);
    const db = openDb(dbPath(env));
    try {
      sync(db, env);
      expect(db.prepare("SELECT tool, session_id, text FROM orphan_prompt ORDER BY tool").all()).toEqual([
        { tool: "claude", session_id: GONE, text: "only in history" },
        { tool: "codex", session_id: GONE, text: "codex prompt" },
      ]);
    } finally {
      closeDb(db);
    }
  });

  test("reads each tool's timestamp in the unit that tool writes", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    seed(env);
    const db = openDb(dbPath(env));
    try {
      sync(db, env);
      expect(db.prepare("SELECT ts FROM orphan_prompt WHERE tool = 'claude'").get()).toEqual({
        ts: "2026-03-04T00:19:50.088Z",
      });
      expect(db.prepare("SELECT ts FROM orphan_prompt WHERE tool = 'codex'").get()).toEqual({
        ts: "2026-02-05T17:43:42.000Z",
      });
    } finally {
      closeDb(db);
    }
  });

  test("re-reading the history files adds nothing", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    seed(env);
    const db = openDb(dbPath(env));
    try {
      sync(db, env);
      const before = db.prepare("SELECT count(*) AS n FROM orphan_prompt").get();
      ingestHistory(db, env);
      ingestHistory(db, env);
      expect(db.prepare("SELECT count(*) AS n FROM orphan_prompt").get()).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  test("stops calling a prompt an orphan once its transcript turns up", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    seed(env);
    const db = openDb(dbPath(env));
    try {
      sync(db, env);
      expect(db.prepare("SELECT count(*) AS n FROM orphan_prompt WHERE session_id = ?").get(GONE)).toEqual({
        n: 2,
      });

      writeClaudeTranscript(env, "-Users-x-code-demo", GONE);
      sync(db, env);
      expect(db.prepare("SELECT count(*) AS n FROM orphan_prompt WHERE tool = 'claude'").get()).toEqual({
        n: 1,
      });
    } finally {
      closeDb(db);
    }
  });

  test("survives a missing history file", () => {
    const root = newRoot();
    const env = scratchEnv(root);
    writeClaudeTranscript(env, "-Users-x-code-demo", LIVE);
    const db = openDb(dbPath(env));
    try {
      expect(ingestHistory(db, env)).toEqual({ read: 0, orphans: 0 });
    } finally {
      closeDb(db);
    }
  });
});
