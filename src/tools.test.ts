import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./schema";
import { TOOLS, TOOLS_SQL } from "./tools";

describe("the tool vocabulary", () => {
  test("is the two tools, spelled as the database spells them", () => {
    expect([...TOOLS]).toEqual(["claude", "codex"]);
    expect(TOOLS_SQL).toBe("'claude','codex'");
  });

  test("reaches every tool column, so the code and the constraint cannot disagree", () => {
    const constrained = SCHEMA_SQL.match(/CHECK \(tool IN \('claude','codex'\)\)/g) ?? [];
    expect(constrained.length).toBe(4);
  });

  test("is what the database accepts and the boundary of it", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);
    for (const tool of TOOLS) {
      db.run(
        "INSERT INTO orphan_prompt (tool, session_id, ts, text) VALUES (?, 's', '2026-01-01T00:00:00Z', 't')",
        [tool],
      );
    }
    expect(() =>
      db.run(
        "INSERT INTO orphan_prompt (tool, session_id, ts, text) VALUES ('cursor', 's', '2026-01-01T00:00:00Z', 't')",
      ),
    ).toThrow();
    db.close();
  });
});
