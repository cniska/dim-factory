import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import { backfillHandoffs, handoffNext, handoffTitle, linkHandoffs, readHandoffs } from "./recall-handoff";

const handoff = (title: string, next = "Get the gate installed.") =>
  `# Handoff — ${title}\n\n## Next\n${next}\n\n## Pointers\n- docs/build-order.md\n`;

function seeded(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  db.run(
    "INSERT INTO source_file (path, tool, kind, session_id) VALUES ('/f.jsonl', 'claude', 'transcript', 'a')",
  );
  for (const id of ["a", "b", "c"]) {
    db.run("INSERT INTO session (id, tool, cwd) VALUES (?, 'claude', '/h/code/demo')", [id]);
  }
  return db;
}

function say(db: Database, id: string, session: string, role: string, ts: string, text: string): void {
  db.run(
    `INSERT INTO message (id, session_id, role, ts, text, src_file, src_line)
     VALUES (?, ?, ?, ?, ?, '/f.jsonl', 1)`,
    [id, session, role, ts, text],
  );
}

describe("what counts as a handoff", () => {
  test("takes the heading line as the key", () => {
    expect(handoffTitle(handoff("earn the first cut"))).toBe("# Handoff — earn the first cut");
  });

  test("rejects a message naming the heading with no Next under it", () => {
    expect(handoffTitle("We should revisit the `# Handoff` heading. ## Next steps are unclear.")).toBeNull();
  });

  test("rejects the heading written mid-sentence rather than as a heading", () => {
    expect(handoffTitle("the # Handoff skill\n\n## Next\nsomething")).toBeNull();
  });

  test("takes the Next belonging to the heading", () => {
    const text = "## Next\nold\n\n# Handoff — current\n\n## Next\ncurrent";
    expect(handoffTitle(text)).toBe("# Handoff — current");
    expect(handoffNext(text)).toBe("current");
  });

  test("backfills only strict heading and section pairs", () => {
    const db = seeded();
    try {
      say(db, "m1", "a", "assistant", "2026-09-01T10:00:00Z", handoff("one"));
      say(db, "m2", "b", "assistant", "2026-09-01T11:00:00Z", "Discussion of # Handoff\n\n## Next\nno");
      say(db, "m3", "c", "assistant", "2026-09-01T12:00:00Z", "# Handoff\n\n## Next steps\nno");
      expect(backfillHandoffs(db)).toEqual({ found: 1 });
      expect(db.query("SELECT message_id, title, next FROM factory_handoff").all()).toEqual([
        { message_id: "m1", title: "# Handoff — one", next: "Get the gate installed." },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("the handoff chain", () => {
  test("joins the session that pasted a handoff to the one that printed it", () => {
    const db = seeded();
    try {
      say(db, "m1", "a", "assistant", "2026-09-01T10:00:00Z", handoff("earn the first cut"));
      say(db, "m2", "b", "user", "2026-09-01T11:00:00Z", handoff("earn the first cut"));
      expect(linkHandoffs(db)).toEqual({ pasted: 1, linked: 1 });
      const link = db.query("SELECT * FROM handoff_link").get() as Record<string, string>;
      expect(link.from_session).toBe("a");
      expect(link.to_session).toBe("b");
      expect(link.from_message).toBe("m1");
      expect(link.title).toBe("# Handoff — earn the first cut");
    } finally {
      db.close();
    }
  });

  test("takes the nearest preceding printer when a title was reused", () => {
    const db = seeded();
    try {
      say(db, "m1", "a", "assistant", "2026-09-01T10:00:00Z", handoff("same title"));
      say(db, "m2", "b", "assistant", "2026-09-02T10:00:00Z", handoff("same title"));
      say(db, "m3", "c", "user", "2026-09-02T11:00:00Z", handoff("same title"));
      linkHandoffs(db);
      expect(db.query("SELECT from_session AS s FROM handoff_link").get()).toEqual({ s: "b" });
    } finally {
      db.close();
    }
  });

  test("links to neither the pasting session itself nor a later printer", () => {
    const db = seeded();
    try {
      say(db, "m1", "b", "assistant", "2026-09-01T10:00:00Z", handoff("self quote"));
      say(db, "m2", "b", "user", "2026-09-01T11:00:00Z", handoff("self quote"));
      say(db, "m3", "a", "assistant", "2026-09-01T12:00:00Z", handoff("self quote"));
      expect(linkHandoffs(db)).toEqual({ pasted: 1, linked: 0 });
    } finally {
      db.close();
    }
  });

  test("leaves a paste unlinked when the writing session was never read", () => {
    const db = seeded();
    try {
      say(db, "m1", "b", "user", "2026-09-01T11:00:00Z", handoff("written elsewhere"));
      expect(linkHandoffs(db)).toEqual({ pasted: 1, linked: 0 });
    } finally {
      db.close();
    }
  });

  test("is replaced whole, dropping a link whose messages have gone", () => {
    const db = seeded();
    try {
      say(db, "m1", "a", "assistant", "2026-09-01T10:00:00Z", handoff("earn the first cut"));
      say(db, "m2", "b", "user", "2026-09-01T11:00:00Z", handoff("earn the first cut"));
      linkHandoffs(db);
      db.run("DELETE FROM message WHERE id = 'm1'");
      expect(linkHandoffs(db)).toEqual({ pasted: 1, linked: 0 });
      expect(db.query("SELECT count(*) AS n FROM handoff_link").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("reads both halves oldest first", () => {
    const db = seeded();
    try {
      say(db, "m2", "b", "user", "2026-09-01T11:00:00Z", handoff("one"));
      say(db, "m1", "a", "assistant", "2026-09-01T10:00:00Z", handoff("one"));
      expect(readHandoffs(db).map((h) => h.messageId)).toEqual(["m1", "m2"]);
    } finally {
      db.close();
    }
  });
});
