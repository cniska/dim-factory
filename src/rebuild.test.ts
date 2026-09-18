import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { SCHEMA_VERSION } from "./schema";
import { rebuild } from "./sync";

type Scratch = { db: Database; env: { HOME: string; DIM_HOME: string } };

function scratch(): Scratch {
  const home = mkdtempSync(join(tmpdir(), "dim-rebuild-"));
  return { db: openDb(join(home, "sessions.db")), env: { HOME: home, DIM_HOME: home } };
}

/** A row in every table that references another, so the drop order is under load. */
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
    "INSERT INTO skill_load (session_id, message_id, ts, skill_name, how) VALUES ('s1', 'm1', '2026-01-01T00:00:00Z', 'dim-fix', 'model')",
  );
  db.run(
    "INSERT INTO repo_commit (sha, repo, ts, subject) VALUES ('abc', '/r', '2026-01-01T00:00:00Z', 'fix: x')",
  );
  db.run("INSERT INTO commit_file (sha, path) VALUES ('abc', '/r/a.ts')");
  db.run(
    "INSERT INTO correction_label (message_id, label, skill_name, rule, labeled_at) VALUES ('m1', 'correction', 'dim-fix', 'ask before pushing', '2026-01-01T00:00:00Z')",
  );
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
    db.run("ALTER TABLE handoff_link DROP COLUMN title");
    expect(columnsOf(db, "tool_call")).not.toContain("duration_ms");

    rebuild(db, env);

    expect(columnsOf(db, "tool_call")).toContain("duration_ms");
    expect(columnsOf(db, "handoff_link")).toContain("title");
    db.close();
  });

  test("a table is dropped before the one it points at, so no row is left dangling", () => {
    const { db, env } = scratch();
    fill(db);

    rebuild(db, env);

    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT count(*) AS n FROM tool_call").get()).toEqual({ n: 0 });
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

  test("a label the owner wrote survives, its message id being written back", () => {
    const { db, env } = scratch();
    fill(db);

    rebuild(db, env);

    expect(db.query("SELECT message_id, label, skill_name, rule FROM correction_label").all()).toEqual([
      { message_id: "m1", label: "correction", skill_name: "dim-fix", rule: "ask before pushing" },
    ]);
    db.close();
  });

  test("a label in a database still carrying the old foreign key survives too", () => {
    const { db, env } = scratch();
    fill(db);
    db.run("DELETE FROM correction_label");
    db.run("DROP TABLE correction_label");
    db.run(
      `CREATE TABLE correction_label (
         message_id TEXT PRIMARY KEY REFERENCES message(id),
         label TEXT NOT NULL,
         skill_name TEXT,
         rule TEXT,
         labeled_at TEXT NOT NULL
       )`,
    );
    db.run(
      "INSERT INTO correction_label (message_id, label, labeled_at) VALUES ('m1', 'clarification', '2026-01-01T00:00:00Z')",
    );

    rebuild(db, env);

    expect(db.query("SELECT message_id, label FROM correction_label").all()).toEqual([
      { message_id: "m1", label: "clarification" },
    ]);
    expect(db.query("PRAGMA foreign_key_list(correction_label)").all()).toEqual([]);
    db.close();
  });

  test("opening for a rebuild leaves the old version in place", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-rebuild-"));
    const path = join(home, "sessions.db");
    const first = openDb(path);
    first.run("UPDATE schema_version SET version = 1");
    first.close();

    const reopened = openDb(path, { forRebuild: true });

    expect(reopened.query("SELECT version FROM schema_version").get()).toEqual({ version: 1 });
    reopened.close();
  });

  test("opening without a rebuild refuses a database an older schema wrote", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-rebuild-"));
    const path = join(home, "sessions.db");
    const first = openDb(path);
    first.run("UPDATE schema_version SET version = 1");
    first.close();

    expect(() => openDb(path)).toThrow(/schema version 1/);
  });
});
