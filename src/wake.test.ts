import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./schema";
import { nextSection, readWake, renderWake } from "./wake";

const HANDOFF = `# Handoff — dim-factory: earn the first cut

## Next
Get the shared commit gate installed, then delete the rule it holds.

## What the next move needs
- Something that must not reach the block.
`;

function seeded(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  const session = (id: string, cwd: string, seen: string, reason: string | null) =>
    db.run(
      `INSERT INTO session (id, tool, cwd, started_at, last_seen_at, end_reason)
       VALUES (?, 'claude', ?, '2026-09-01T00:00:00Z', ?, ?)`,
      [id, cwd, seen, reason],
    );
  session("older", "/h/code/demo", "2026-09-01T10:00:00Z", "clear");
  session("newest", "/h/code/demo", "2026-09-02T10:00:00Z", "prompt_input_exit");
  session("elsewhere", "/h/code/other", "2026-09-03T10:00:00Z", "clear");
  db.run(
    "INSERT INTO source_file (path, tool, kind, session_id) VALUES ('/f.jsonl', 'claude', 'transcript', 'newest')",
  );
  db.run(
    `INSERT INTO message (id, session_id, role, ts, text, attribution_skill, src_file, src_line) VALUES
       ('m1', 'newest', 'assistant', '2026-09-02T09:00:00Z', ?, 'handoff', '/f.jsonl', 1),
       ('m2', 'elsewhere', 'assistant', '2026-09-03T09:00:00Z', 'wrong project', 'handoff', '/f.jsonl', 2)`,
    [HANDOFF],
  );
  return db;
}

describe("the wake block", () => {
  test("carries the Next and stops at the heading after it", () => {
    expect(nextSection(HANDOFF)).toBe("Get the shared commit gate installed, then delete the rule it holds.");
  });

  test("takes the last session in this directory, not the last session anywhere", () => {
    const db = seeded();
    try {
      const wake = readWake(db, "/h/code/demo");
      expect(wake?.sessionId).toBe("newest");
      expect(wake?.endReason).toBe("prompt_input_exit");
      expect(wake?.next).toContain("commit gate installed");
      // The section after Next is the handoff's own detail; a cold start reads it from the file.
      expect(wake?.next).not.toContain("must not reach the block");
    } finally {
      db.close();
    }
  });

  // The block is added to every session that starts here, so it has to cost
  // nothing when it has nothing: silence, not a header saying there is no news.
  // Most sessions that talk about handoffs never print one, and the heading
  // alone would hand the next session whatever the last one merely discussed.
  test("ignores a message that names a handoff but leaves no Next", () => {
    const db = seeded();
    try {
      // Later than the real handoff, in the same directory, and only talking about one.
      db.run(
        `INSERT INTO message (id, session_id, role, ts, text, src_file, src_line)
         VALUES ('m4', 'older', 'assistant', '2026-09-09T00:00:00Z',
                 'We should look at the # Handoff from yesterday.', '/f.jsonl', 4)`,
      );
      expect(readWake(db, "/h/code/demo")?.sessionId).toBe("newest");
      expect(readWake(db, "/h/code/demo")?.next).toContain("commit gate installed");
    } finally {
      db.close();
    }
  });

  test("renders nothing for a directory no session has worked in", () => {
    const db = seeded();
    try {
      expect(readWake(db, "/h/code/untouched")).toBeNull();
      expect(renderWake(null)).toBe("");
    } finally {
      db.close();
    }
  });

  test("truncates a Next that would spend the budget on one session", () => {
    const long = `# Handoff\n\n## Next\n${"word ".repeat(400)}\n\n## Pointers\n`;
    const section = nextSection(long) as string;
    expect(section.length).toBeLessThanOrEqual(701);
    expect(section.endsWith("…")).toBe(true);
  });
});
