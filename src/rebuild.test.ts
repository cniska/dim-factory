import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, recordVersion } from "./db";
import { SCHEMA_VERSION } from "./db-schema";
import { rebuild } from "./ingest-sync";
import { dbPath } from "./paths";

type Scratch = { db: Database; env: { HOME: string; XDG_DATA_HOME: string } };

function scratch(): Scratch {
  const home = mkdtempSync(join(tmpdir(), "dim-rebuild-"));
  const env = { HOME: home, XDG_DATA_HOME: home };
  return { db: openDb(dbPath(env)), env };
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
    db.run("DROP TABLE run");
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    db.close();

    const reopened = openDb(dbPath(env), { forRebuild: true });
    rebuild(reopened, env);

    expect(columnsOf(reopened, "tool_call")).toContain("file_path");
    expect(tablesOf(reopened)).toContain("run");
    expect(recordVersion(reopened)).toBe(SCHEMA_VERSION);
    reopened.close();
  });

  test("a row in every table that references another does not stop the drops", () => {
    const { db, env } = scratch();
    fill(db);

    rebuild(db, env);

    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  test("drops a large table that another references through an unindexed column without checking each row", () => {
    const { db, env } = scratch();
    const rows = 50_000;
    db.run("CREATE TABLE old_parent (id INTEGER PRIMARY KEY)");
    db.run("CREATE TABLE old_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES old_parent(id))");
    db.transaction(() => {
      for (let id = 1; id <= rows; id++) {
        db.run("INSERT INTO old_parent (id) VALUES (?)", [id]);
        db.run("INSERT INTO old_child (id, parent_id) VALUES (?, ?)", [id, id]);
      }
    })();

    const started = performance.now();
    rebuild(db, env);

    expect(performance.now() - started).toBeLessThan(3000);
    expect(tablesOf(db)).not.toContain("old_parent");
    db.close();
  }, 120_000);

  test("a rebuild that throws leaves the old version stamped", () => {
    const { db, env } = scratch();
    db.run("PRAGMA user_version = 1");
    const blocked = join(env.HOME, "not-a-directory");
    writeFileSync(blocked, "");

    expect(() => rebuild(db, { HOME: blocked, XDG_DATA_HOME: blocked })).toThrow();
    expect(recordVersion(db)).toBe(1);

    rebuild(db, env);
    expect(recordVersion(db)).toBe(SCHEMA_VERSION);
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

  test("hook events keep the rows the current definition accepts while their table takes it", () => {
    const { db, env } = scratch();
    db.run("DROP TABLE hook_event");
    db.run(
      `CREATE TABLE hook_event (
         id INTEGER PRIMARY KEY,
         tool TEXT NOT NULL CHECK (tool IN ('claude','codex')),
         session_id TEXT NOT NULL,
         event TEXT NOT NULL CHECK (event IN ('session_start','session_end','post_tool_use')),
         ts TEXT NOT NULL,
         harness_pid INTEGER, source TEXT, reason TEXT, model TEXT, cwd TEXT,
         payload TEXT NOT NULL,
         UNIQUE (session_id, event, ts)
       )`,
    );
    db.run(
      "INSERT INTO hook_event (tool, session_id, event, ts, reason, payload) VALUES ('claude', 's1', 'session_end', '2026-01-01T00:00:00Z', 'clear', '{}')",
    );
    db.run(
      "INSERT INTO hook_event (tool, session_id, event, ts, payload) VALUES ('claude', 's1', 'post_tool_use', '2026-01-01T00:00:01Z', '{}')",
    );

    rebuild(db, env);

    expect(
      db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hook_event'").get(),
    ).toEqual({ sql: currentDefinitions().hook_event });
    expect(db.query("SELECT session_id, event, reason FROM hook_event").all()).toEqual([
      { session_id: "s1", event: "session_end", reason: "clear" },
    ]);
    db.close();
  });

  test("a table the schema no longer defines is dropped", () => {
    const { db, env } = scratch();
    db.run("CREATE TABLE retired (id INTEGER PRIMARY KEY)");

    rebuild(db, env);

    expect(tablesOf(db)).not.toContain("retired");
    expect(tablesOf(db)).toContain("message_fts");
    db.close();
  });

  test("the factory's tables are reset to the current definition", () => {
    const { db, env } = scratch();
    db.run("DROP TABLE order_log");
    db.run("CREATE TABLE order_log (order_id TEXT, seq INTEGER, action TEXT, PRIMARY KEY (order_id, seq))");
    db.run("INSERT INTO order_log VALUES ('k7m2qx4d', 1, 'order_added')");

    rebuild(db, env);

    expect(
      db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'order_log'").get(),
    ).toEqual({ sql: currentDefinitions().order_log });
    expect(db.query("SELECT count(*) AS n FROM order_log").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("opening a database an older schema wrote", () => {
  function stampedOld(): string {
    const path = join(mkdtempSync(join(tmpdir(), "dim-rebuild-")), "sessions.db");
    const db = openDb(path);
    db.run("PRAGMA user_version = 1");
    db.close();
    return path;
  }

  test("opening for a rebuild leaves the old version in place", () => {
    const db = openDb(stampedOld(), { forRebuild: true });

    expect(recordVersion(db)).toBe(1);
    db.close();
  });

  test("opening for anything else refuses it", () => {
    const path = stampedOld();

    expect(() => openDb(path)).toThrow(expect.objectContaining({ code: "record_version" }));
  });
});
