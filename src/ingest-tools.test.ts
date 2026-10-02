import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { SCHEMA_SQL } from "./db-schema";
import { scratchEnv } from "./fixtures.test-support";
import { sync } from "./ingest-sync";
import { TOOLS } from "./ingest-tools";
import { dbPath } from "./paths";

describe("the tool vocabulary", () => {
  test("is the tools, spelled as the database spells them", () => {
    expect([...TOOLS]).toEqual(["claude", "codex", "grok", "pi", "omp"]);
  });

  test("is every source a sync reads, in its order", () => {
    const root = mkdtempSync(join(tmpdir(), "dim-tools-"));
    const env = scratchEnv(root);
    const db = openDb(dbPath(env));
    try {
      expect(sync(db, env).sources).toEqual(TOOLS.map((tool) => ({ tool, files: 0 })));
    } finally {
      closeDb(db);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reaches every tool column, so the code and the constraint cannot disagree", () => {
    const constrained = SCHEMA_SQL.match(/CHECK \(tool IN \('claude','codex','grok','pi','omp'\)\)/g) ?? [];
    expect(constrained.length).toBe(3);
  });

  test("is what the database accepts and the boundary of it", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    for (const tool of TOOLS) {
      db.run("INSERT INTO session (id, tool) VALUES (?, ?)", [tool, tool]);
    }
    expect(() => db.run("INSERT INTO session (id, tool) VALUES ('s', 'cursor')")).toThrow();
    db.close();
  });
});
