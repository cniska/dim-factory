import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { SCHEMA_SQL } from "./db-schema";
import { scratchEnv } from "./fixtures.test-support";
import { HOOK_EVENTS } from "./hook-events";
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

  test("is what every tool column accepts and the boundary of it", () => {
    const db = new Database(":memory:");
    const event = HOOK_EVENTS.SessionStart;
    const inserts: Record<string, (tool: string, key: string) => void> = {
      source_file: (tool, key) =>
        db.run("INSERT INTO source_file (path, tool, kind, session_id) VALUES (?, ?, 'transcript', ?)", [
          key,
          tool,
          key,
        ]),
      session: (tool, key) => db.run("INSERT INTO session (id, tool) VALUES (?, ?)", [key, tool]),
      hook_event: (tool, key) =>
        db.run(
          "INSERT INTO hook_event (tool, session_id, event, ts) VALUES (?, ?, ?, '2026-01-01T00:00:00Z')",
          [tool, key, event],
        ),
    };
    try {
      db.run(SCHEMA_SQL);
      for (const [table, insert] of Object.entries(inserts)) {
        for (const tool of TOOLS) {
          expect(() => insert(tool, `${table}-${tool}`), `${table} accepts ${tool}`).not.toThrow();
        }
        expect(() => insert("cursor", `${table}-cursor`), `${table} refuses cursor`).toThrow(
          /CHECK constraint failed: tool IN/,
        );
      }
    } finally {
      db.close();
    }
  });
});
