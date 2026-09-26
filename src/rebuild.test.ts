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
    "INSERT INTO skill_load (session_id, message_id, ts, skill_name, how) VALUES ('s1', 'm1', '2026-01-01T00:00:00Z', 'dim-line-fix', 'model')",
  );
  db.run(
    "INSERT INTO repo_commit (sha, repo, ts, subject) VALUES ('abc', '/r', '2026-01-01T00:00:00Z', 'fix: x')",
  );
  db.run("INSERT INTO commit_file (sha, path) VALUES ('abc', '/r/a.ts')");
  db.run(
    "INSERT INTO correction_label (message_id, label, skill_name, rule, labeled_at) VALUES ('m1', 'correction', 'dim-line-fix', 'ask before pushing', '2026-01-01T00:00:00Z')",
  );
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
    db.run("ALTER TABLE handoff_link DROP COLUMN title");
    expect(columnsOf(db, "tool_call")).not.toContain("duration_ms");

    rebuild(db, env);

    expect(columnsOf(db, "tool_call")).toContain("duration_ms");
    expect(columnsOf(db, "handoff_link")).toContain("title");
    db.close();
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

  test("a label the owner wrote survives, its message id being written back", () => {
    const { db, env } = scratch();
    fill(db);

    rebuild(db, env);

    expect(db.query("SELECT message_id, label, skill_name, rule FROM correction_label").all()).toEqual([
      { message_id: "m1", label: "correction", skill_name: "dim-line-fix", rule: "ask before pushing" },
    ]);
    db.close();
  });

  test("a label in a database still carrying the old foreign key survives too", () => {
    const { db, env } = scratch();
    fill(db);
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
});

describe("rebuilding a database an older schema wrote", () => {
  /** What a fresh database puts in `sqlite_master`, which is what a rebuilt one must match. */
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
    // The shape `hook_event` had before post-tool events joined it. `CREATE TABLE IF NOT
    // EXISTS` leaves this alone, so only a drop can widen the check again.
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
    // The spool deletes each file once it is read, so these rows have no source to re-read
    // and a rebuild that drops the table has to write them back.
    expect(db.query("SELECT session_id, event FROM hook_event").all()).toEqual([
      { session_id: "s1", event: "session_start" },
    ]);
    db.close();
  });

  test("a factory order reaches the current schema with its evidence intact", () => {
    const { db, env } = scratch();
    db.run("ALTER TABLE factory_order DROP COLUMN stop_reason");
    db.run(
      `INSERT INTO factory_order (id, project, title, status, created_at, updated_at)
       VALUES ('order-1', 'cniska/dim-factory', 'Survive a rebuild', 'working', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    db.run(
      "INSERT INTO factory_worker (name, role, token_digest, started_at) VALUES ('copper-1', 'builder', 'x', '2026-01-01T00:00:00Z')",
    );
    db.run(
      `INSERT INTO factory_order_event (order_id, ts, kind, worker)
       VALUES ('order-1', '2026-01-01T00:00:00Z', 'claimed', 'copper-1')`,
    );
    db.run(
      "INSERT INTO factory_order_commit (order_id, sha, recorded_at) VALUES ('order-1', 'abc', '2026-01-01T00:00:00Z')",
    );

    rebuild(db, env);

    expect(columnsOf(db, "factory_order")).toContain("stop_reason");
    expect(db.query("SELECT id, project, status FROM factory_order").all()).toEqual([
      { id: "order-1", project: "cniska/dim-factory", status: "working" },
    ]);
    expect(db.query("SELECT order_id, kind FROM factory_order_event").all()).toEqual([
      { order_id: "order-1", kind: "claimed" },
    ]);
    expect(db.query("SELECT order_id, sha FROM factory_order_commit").all()).toEqual([
      { order_id: "order-1", sha: "abc" },
    ]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  test("first-party lifecycle records and diagnostics survive a rebuild together", () => {
    const { db, env } = scratch();
    db.run(
      `INSERT INTO factory_order (id, project, title, status, created_at, updated_at)
       VALUES ('order-history', 'cniska/dim-factory', 'Keep lifecycle history', 'working',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    db.run(
      "INSERT INTO factory_worker (name, role, token_digest, started_at, session_id) VALUES ('copper-1', 'builder', 'x', '2026-01-01T00:00:00Z', 'session-1')",
    );
    db.run(
      `INSERT INTO factory_order_event (order_id, ts, kind, worker, evidence)
       VALUES ('order-history', '2026-01-01T00:00:00Z', 'queued', 'copper-1', '{"provenance":"issue-1"}')`,
    );
    db.run(
      `INSERT INTO factory_order_attempt
         (order_id, run_id, worker, station, harness, model, tier, started_at, recorded_at, kind, outcome)
       VALUES ('order-history', 'run-1', 'copper-1', 'build', 'codex', 'gpt-test', 'standard',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'started', 'running')`,
    );
    db.run(
      "INSERT INTO factory_schedule (id, queue_id, interval_seconds, created_at, updated_at) VALUES ('schedule-history', 'queue', 60, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    );
    db.run(
      `INSERT INTO factory_schedule_invocation
         (schedule_id, evaluated_at, due, dispatched, selected_order_ids, worker, session_id, harness, model, tier, outcome)
       VALUES ('schedule-history', '2026-01-01T00:01:00Z', 1, 1, '["order-history"]', 'copper-1', 'session-1', 'codex', 'gpt-test', 'standard', 'dispatched')`,
    );
    db.run(
      `INSERT INTO factory_order_verdict (order_id, decision, grounds, worker, session_id, recorded_at)
       VALUES ('order-history', 'approved', 'ready', 'copper-1', 'session-1', '2026-01-01T00:02:00Z')`,
    );
    db.run(
      `INSERT INTO factory_order_delivery (order_id, kind, outcome, worker, session_id, recorded_at)
       VALUES ('order-history', 'delivery', 'succeeded', 'copper-1', 'session-1', '2026-01-01T00:03:00Z')`,
    );
    db.run(
      `INSERT INTO trace_event (ts, event, order_id, worker, session_id, fields)
       VALUES ('2026-01-01T00:03:00Z', 'delivery.debug', 'order-history', 'copper-1', 'session-1', '{}')`,
    );

    rebuild(db, env);

    expect(db.query("SELECT count(*) AS n FROM factory_order_event").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM factory_order_attempt").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM factory_schedule_invocation").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM factory_order_verdict").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM factory_order_delivery").get()).toEqual({ n: 1 });
    expect(db.query("SELECT event FROM trace_event").all()).toEqual([{ event: "delivery.debug" }]);
    db.close();
  });

  test("an order's worker written before harnesses were recorded comes back as codex", () => {
    const { db, env } = scratch();
    db.run("ALTER TABLE factory_order_worker DROP COLUMN harness");
    db.run(
      `INSERT INTO factory_order (id, project, title, status, created_at, updated_at)
       VALUES ('order-1', 'cniska/dim-factory', 'Survive a rebuild', 'working', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    db.run(
      "INSERT INTO factory_worker (name, role, token_digest, started_at) VALUES ('copper-1', 'operator', 'x', '2026-01-01T00:00:00Z')",
    );
    db.run(
      `INSERT INTO factory_worker_assignment (id, parent_worker, role, token_digest, created_at)
       VALUES ('assignment-1', 'copper-1', 'builder', 'y', '2026-01-01T00:00:00Z')`,
    );
    db.run(
      `INSERT INTO factory_order_worker (order_id, role, assignment_id, created_at)
       VALUES ('order-1', 'builder', 'assignment-1', '2026-01-01T00:00:00Z')`,
    );

    rebuild(db, env);

    expect(db.query("SELECT order_id, role, harness FROM factory_order_worker").all()).toEqual([
      { order_id: "order-1", role: "builder", harness: "codex" },
    ]);
    db.close();
  });

  test("a factory order keeps the words it was queued with", () => {
    const { db, env } = scratch();
    db.run(
      `INSERT INTO factory_order (id, project, title, description, status, created_at, updated_at)
       VALUES ('order-1', 'cniska/dim-factory', 'Survive a rebuild',
               'No surface can tell a reader what an order is about.', 'working',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );

    rebuild(db, env);

    expect(db.query("SELECT id, description FROM factory_order").all()).toEqual([
      { id: "order-1", description: "No surface can tell a reader what an order is about." },
    ]);
    db.close();
  });

  test("a plan an order was built from is still readable after a rebuild", () => {
    const { db, env } = scratch();
    db.run(
      `INSERT INTO factory_order (id, project, title, status, created_at, updated_at)
       VALUES ('order-1', 'cniska/dim-factory', 'Keep the plan', 'working', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    db.run(
      "INSERT INTO factory_worker (name, role, token_digest, started_at) VALUES ('copper-1', 'planner', 'x', '2026-01-01T00:00:00Z')",
    );
    db.run(
      `INSERT INTO factory_order_plan (order_id, worker, body, recorded_at)
       VALUES ('order-1', 'copper-1', '## outcome\n\nMove the order before building.', '2026-01-01T00:00:00Z')`,
    );

    rebuild(db, env);

    expect(db.query("SELECT order_id, body FROM factory_order_plan").all()).toEqual([
      { order_id: "order-1", body: "## outcome\n\nMove the order before building." },
    ]);
    db.close();
  });

  test("a stopped floor is still stopped after a rebuild", () => {
    const { db, env } = scratch();
    // Nothing re-reads this row either, so only the drop and write-back can bring
    // a table whose definition went stale up to the current one.
    db.run("ALTER TABLE factory_stop DROP COLUMN order_id");
    db.run(
      `INSERT INTO factory_stop (reason, pulled_by, pulled_at)
       VALUES ('the commit gate records nothing', 'operator', '2026-09-19T09:00:00.000Z')`,
    );

    rebuild(db, env);

    expect(columnsOf(db, "factory_stop")).toContain("order_id");
    expect(db.query("SELECT reason FROM factory_stop WHERE cleared_at IS NULL").all()).toEqual([
      { reason: "the commit gate records nothing" },
    ]);
    db.close();
  });

  test("evidence left behind by an order deleted outside the code goes with the order", () => {
    const { db, env } = scratch();
    // What a hand-run `sqlite3` does: its foreign keys are off by default, so a
    // deleted order leaves its children behind for the restore to be refused on.
    db.run("PRAGMA foreign_keys = OFF");
    db.run(
      `INSERT INTO factory_order (id, project, title, status, created_at, updated_at)
       VALUES ('order-kept', 'cniska/dim-factory', 'Survive a rebuild', 'working', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    db.run(
      "INSERT INTO factory_worker (name, role, token_digest, started_at) VALUES ('copper-1', 'builder', 'x', '2026-01-01T00:00:00Z')",
    );
    db.run(
      `INSERT INTO factory_order_event (order_id, ts, kind, worker)
       VALUES ('order-kept', '2026-01-01T00:00:00Z', 'claimed', 'copper-1'),
              ('order-gone', '2026-01-01T00:00:00Z', 'claimed', 'copper-1')`,
    );
    db.run(
      `INSERT INTO factory_order_commit (order_id, sha, recorded_at)
       VALUES ('order-gone', 'abc', '2026-01-01T00:00:00Z')`,
    );
    db.run("PRAGMA foreign_keys = ON");

    const report = rebuild(db, env);

    expect(db.query("SELECT order_id FROM factory_order_event").all()).toEqual([{ order_id: "order-kept" }]);
    expect(db.query("SELECT order_id FROM factory_order_commit").all()).toEqual([]);
    expect(report.orphans).toEqual([
      { table: "factory_order_commit", rows: 1 },
      { table: "factory_order_event", rows: 1 },
    ]);
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

  test("a factory order written before the title column stops the rebuild", () => {
    const { db, env } = scratch();
    db.run("ALTER TABLE factory_order DROP COLUMN title");
    db.run(
      `INSERT INTO factory_order (id, project, status, created_at, updated_at)
       VALUES ('order-old', 'cniska/dim-factory', 'working', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );

    // Named with the column and the ways out, because rebuild is the only route
    // these rows have and what such a row should be called is the owner's to say.
    expect(() => rebuild(db, env)).toThrow(/factory_order\.title/);
    expect(() => rebuild(db, env)).toThrow(/sqlite3/);

    expect(db.query("SELECT id FROM factory_order").all()).toEqual([{ id: "order-old" }]);
    db.close();
  });

  test("a factory table retired from the schema is dropped during rebuild", () => {
    const { db, env } = scratch();
    db.run(
      `CREATE TABLE factory_order_account (
         id INTEGER PRIMARY KEY,
         order_id TEXT NOT NULL REFERENCES factory_order(id) ON DELETE CASCADE,
         body TEXT NOT NULL
       )`,
    );
    db.run(
      `INSERT INTO factory_order (id, project, title, status, created_at, updated_at)
       VALUES ('order-1', 'cniska/dim-factory', 'Retire an old table', 'queued', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    db.run("INSERT INTO factory_order_account (order_id, body) VALUES ('order-1', 'old artifact')");

    rebuild(db, env);

    expect(
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'factory_order_account'")
        .get(),
    ).toBeNull();
    expect(db.query("SELECT id FROM factory_order WHERE id = 'order-1'").get()).toEqual({ id: "order-1" });
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
