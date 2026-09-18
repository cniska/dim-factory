import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { dbPath, type Env } from "./paths";
import { SCHEMA_VERSION } from "./schema";
import { trace } from "./trace";

const roots: string[] = [];

function scratch(): Env {
  const root = mkdtempSync(join(tmpdir(), "dim-trace-"));
  roots.push(root);
  return { DIM_HOME: root };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function rows(env: Env): Record<string, unknown>[] {
  const db = new Database(dbPath(env), { readonly: true });
  try {
    return db.query("SELECT * FROM command_trace ORDER BY id").all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

describe("the command trace", () => {
  test("records which branch answered, with the shape of the result", () => {
    const env = scratch();
    closeDb(openDb(dbPath(env)));
    trace({ command: "q", name: "search", path: "keyword", rowCount: 3, durationMs: 12 }, env);
    expect(rows(env)).toMatchObject([
      { command: "q", name: "search", path: "keyword", row_count: 3, duration_ms: 12 },
    ]);
  });

  // A bare connection does not run SCHEMA_SQL, so on any database written before
  // this table existed every insert would be `no such table` and the catch would
  // hide it. Verified by writing into a database created without the table.
  test("writes into a database that predates the table", () => {
    const env = scratch();
    const db = new Database(dbPath(env), { create: true });
    db.run("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    // The version this build expects, so the database is current in every way
    // except the missing table, which is the thing under test.
    db.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
    db.close();

    trace({ command: "q", name: "chain" }, env);
    expect(rows(env)).toHaveLength(1);
  });

  test("drops the row rather than failing the command it traces", () => {
    const env = scratch();
    expect(() =>
      trace({ command: "q", name: "chain" }, { ...env, DIM_HOME: "/nowhere/at/all" }),
    ).not.toThrow();
  });
});
