import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import { TOOLS } from "./ingest-tools";

describe("the tool vocabulary", () => {
  test("is the tools, spelled as the database spells them", () => {
    expect([...TOOLS]).toEqual(["claude", "codex", "grok", "pi", "omp"]);
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
