import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { SCHEMA_VERSION } from "./db-schema";
import { rebuild } from "./ingest-sync";

type Scratch = { db: Database; env: { HOME: string; DIM_HOME: string } };

function scratch(): Scratch {
  const home = mkdtempSync(join(tmpdir(), "dim-rebuild-"));
  return { db: openDb(join(home, "sessions.db")), env: { HOME: home, DIM_HOME: home } };
}

function fill(db: Database): void {
  db.run("INSERT INTO session (id, tool) VALUES ('parent', 'claude')");
  db.run("INSERT INTO session (id, tool, parent_id) VALUES ('s1', 'claude', 'parent')");
  db.run(
    "INSERT INTO source_file (path, tool, kind, session_id) VALUES ('/f.jsonl', 'claude', 'transcript', 's1')",
  );
  db.run(
    "INSERT INTO message (id, session_id, ts, role, src_file, src_line) VALUES ('m1', 's1', '2026-01-01T00:00:00Z', 'user', '/f.jsonl', 1)",
  );
  db.run(
    "INSERT INTO usage (response_id, session_id, message_id, ts, input_tokens, output_tokens) VALUES ('r1', 's1', 'm1', '2026-01-01T00:00:00Z', 1, 1)",
  );
  db.run("INSERT INTO turn (session_id, turn_id, ts_end) VALUES ('s1', 't1', '2026-01-01T00:00:00Z')");
  db.run(
    "INSERT INTO session_cost_reported (session_id, reported_by, model_usage) VALUES ('s1', 'claude', '{}')",
  );
  db.run(
    "INSERT INTO tool_call (id, session_id, message_id, tool_name, src_file) VALUES ('tc1', 's1', 'm1', 'Bash', '/f.jsonl')",
  );
  db.run("INSERT INTO git_command (tool_call_id, position, subcommand) VALUES ('tc1', 0, 'commit')");
  db.run(
    "INSERT INTO skill_load (session_id, message_id, ts, skill_name, how) VALUES ('s1', 'm1', '2026-01-01T00:00:00Z', 'dim-line-fix', 'model')",
  );
  db.run(
    "INSERT INTO repo_commit (sha, repo, ts, subject) VALUES ('abc', '/r', '2026-01-01T00:00:00Z', 'fix: x')",
  );
  db.run("INSERT INTO commit_file (sha, path) VALUES ('abc', '/r/a.ts')");
}

function tablesOf(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

function columnsOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

describe("absorbing a schema change", () => {
  test("a column missing from a table rebuild re-reads is back afterwards", () => {
    const { db, env } = scratch();
    fill(db);
    db.run("ALTER TABLE tool_call DROP COLUMN duration_ms");
    expect(columnsOf(db, "tool_call")).not.toContain("duration_ms");

    rebuild(db, env);

    expect(columnsOf(db, "tool_call")).toContain("duration_ms");
    db.close();
  });

  test("a database opened for rebuild takes a new indexed column and a new table", () => {
    const { db, env } = scratch();
    fill(db);
    db.run("DROP INDEX tool_call_file");
    db.run("ALTER TABLE tool_call DROP COLUMN file_path");
    db.run("DROP TABLE guidance_walk");
    db.run("UPDATE schema_version SET version = ?", [SCHEMA_VERSION - 1]);
    db.close();

    const reopened = openDb(join(env.DIM_HOME, "sessions.db"), { forRebuild: true });
    rebuild(reopened, env);

    expect(columnsOf(reopened, "tool_call")).toContain("file_path");
    expect(tablesOf(reopened)).toContain("guidance_walk");
    expect(reopened.query("SELECT version FROM schema_version").get()).toEqual({ version: SCHEMA_VERSION });
    reopened.close();
  });

  test("a row in every table that references another does not stop the drops", () => {
    const { db, env } = scratch();
    fill(db);

    rebuild(db, env);

    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  test("a rebuild that throws leaves the old version stamped", () => {
    const { db, env } = scratch();
    db.run("UPDATE schema_version SET version = 1");
    const blocked = join(env.HOME, "not-a-directory");
    writeFileSync(blocked, "");

    expect(() => rebuild(db, { HOME: blocked, DIM_HOME: blocked })).toThrow();
    expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: 1 });

    rebuild(db, env);
    expect(db.query("SELECT version FROM schema_version").get()).toEqual({
      version: SCHEMA_VERSION,
    });
    db.close();
  });
});

describe("rebuilding a database an older schema wrote", () => {
  function currentDefinitions(): Record<string, string> {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "dim-rebuild-")), "sessions.db"));
    const rows = db
      .query<{ name: string; sql: string }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL",
      )
      .all();
    db.close();
    return Object.fromEntries(rows.map((row) => [row.name, row.sql]));
  }

  test("a table whose definition went stale is brought up to the current schema", () => {
    const { db, env } = scratch();
    db.run("DROP TABLE hook_event");
    db.run(
      `CREATE TABLE hook_event (
         id INTEGER PRIMARY KEY,
         tool TEXT NOT NULL CHECK (tool IN ('claude','codex')),
         session_id TEXT NOT NULL,
         event TEXT NOT NULL CHECK (event IN ('session_start','session_end')),
         ts TEXT NOT NULL,
         source TEXT, reason TEXT, model TEXT, cwd TEXT,
         payload TEXT NOT NULL,
         UNIQUE (session_id, event, ts)
       )`,
    );
    db.run(
      "INSERT INTO hook_event (tool, session_id, event, ts, payload) VALUES ('claude', 's1', 'session_start', '2026-01-01T00:00:00Z', '{}')",
    );

    rebuild(db, env);

    expect(
      db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hook_event'").get(),
    ).toEqual({ sql: currentDefinitions().hook_event });
    expect(db.query("SELECT session_id, event FROM hook_event").all()).toEqual([
      { session_id: "s1", event: "session_start" },
    ]);
    db.close();
  });

  test("the trace survives a rebuild", () => {
    const { db, env } = scratch();
    db.run(
      `INSERT INTO trace_event (ts, event, order_id, session_id, fields)
       VALUES ('2026-01-01T00:03:00Z', 'ship.debug', 'order-history', 'session-1', '{}')`,
    );

    rebuild(db, env);

    expect(db.query("SELECT event FROM trace_event").all()).toEqual([{ event: "ship.debug" }]);
    db.close();
  });

  test("a table the schema has stopped defining is gone, and the search index is not", () => {
    const { db, env } = scratch();
    db.run("CREATE TABLE queue_item (queue_id TEXT, id TEXT, PRIMARY KEY (queue_id, id))");
    db.run(
      `CREATE TABLE queue_item_transition (
         queue_id TEXT NOT NULL, item_id TEXT NOT NULL,
         FOREIGN KEY (queue_id, item_id) REFERENCES queue_item(queue_id, id) ON DELETE CASCADE)`,
    );
    db.run("INSERT INTO queue_item (queue_id, id) VALUES ('build-order', 'item-1')");
    db.run("INSERT INTO queue_item_transition (queue_id, item_id) VALUES ('build-order', 'item-1')");

    rebuild(db, env);

    expect(tablesOf(db)).not.toContain("queue_item");
    expect(tablesOf(db)).not.toContain("queue_item_transition");
    expect(tablesOf(db)).toContain("message_fts");
    expect(tablesOf(db)).toContain("message_fts_data");
    db.close();
  });
});

describe("opening a database an older schema wrote", () => {
  function stampedOld(): string {
    const path = join(mkdtempSync(join(tmpdir(), "dim-rebuild-")), "sessions.db");
    const db = openDb(path);
    db.run("UPDATE schema_version SET version = 1");
    db.close();
    return path;
  }

  test("opening for a rebuild leaves the old version in place", () => {
    const db = openDb(stampedOld(), { forRebuild: true });

    expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: 1 });
    db.close();
  });

  test("opening for anything else refuses it", () => {
    const path = stampedOld();

    expect(() => openDb(path)).toThrow(/schema version 1/);
  });
});
