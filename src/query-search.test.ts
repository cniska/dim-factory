import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SCHEMA_SQL } from "./db-schema";
import type { QueryContext, QueryResult } from "./query";
import { findQuery } from "./query-registry";

const search = findQuery("search") as NonNullable<ReturnType<typeof findQuery>>;

function seeded(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  db.run(
    `INSERT INTO session (id, tool, cwd, project, started_at, last_seen_at)
     VALUES ('s1', 'claude', '/w', '/home/code/dim-factory', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')`,
  );
  db.run(
    `INSERT INTO source_file (path, tool, kind, session_id) VALUES ('/f.jsonl', 'claude', 'transcript', 's1')`,
  );
  db.run(
    `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
     VALUES ('m-said', 's1', '2026-09-01T10:30:00Z', 'assistant', ?, '/f.jsonl', 1)`,
    ["Undo what an agent wrote without touching the user's own checkout."],
  );
  db.run(
    `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line, is_meta)
     VALUES ('m-meta', 's1', '2026-09-01T10:31:00Z', 'user', ?, '/f.jsonl', 2, 1)`,
    ["Injected reminder about the checkout."],
  );
  return db;
}

const ctx: QueryContext = { since: null, home: "/home" };

const ask = (db: Database, over: Partial<QueryContext>): QueryResult => search.run(db, { ...ctx, ...over });

describe("search", () => {
  test("finds the word that was typed", () => {
    const db = seeded();
    const result = ask(db, { arg: "checkout" });
    expect(result.columns).toEqual(["session", "when", "ref", "role", "project", "terms", "text"]);
    expect(result.rows.map((r) => String(r[0]))).toEqual(["s1"]);
    db.close();
  });

  test("matches what someone said, not text injected into the session", () => {
    const db = seeded();
    const result = ask(db, { arg: "checkout" });
    expect(String(result.rows[0]?.[6])).not.toContain("Injected");
    expect(result.denominator).toContain("1 of 2 messages that carry text anyone said");
    db.close();
  });

  test("prints the matching message's session and timestamp, which thread reads", () => {
    const db = seeded();
    const result = ask(db, { arg: "checkout" });
    expect(result.rows[0]?.[result.columns.indexOf("ref")]).toBe("s1@2026-09-01T10:30:00Z");
    expect(result.denominator).toContain("dim q thread <session>@<when>");
    db.close();
  });

  test("spans history, so an old decision is still reachable", () => {
    const db = seeded();
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
       VALUES ('m-old', 's1', '2024-03-04T09:00:00Z', 'user', ?, '/f.jsonl', 9)`,
      ["We settled on the shadow checkout back then."],
    );
    const result = ask(db, { arg: "settled" });
    expect(result.rows.map((r) => String(r[1]))).toEqual(["2024-03-04T09:00"]);
    expect(result.denominator).toContain("all time");
    db.close();
  });

  test("finds what another agent said, which the harness only carried", () => {
    const db = seeded();
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line, is_meta, origin_kind)
       VALUES ('m-peer', 's1', '2026-09-01T10:33:00Z', 'user', ?, '/f.jsonl', 4, 1, 'peer')`,
      ["Another Claude session sent a message: we decided against the second checkout."],
    );
    const result = ask(db, { arg: "decided" });
    expect(result.rows.map((r) => String(r[0]))).toEqual(["s1"]);
    const ref = String(result.rows[0]?.[result.columns.indexOf("ref")]);
    expect(ref).toBe("s1@2026-09-01T10:33:00Z");
    const thread = findQuery("thread")?.run(db, { ...ctx, arg: ref });
    expect(thread?.rows.some((row) => String(row[3]).includes("decided against"))).toBe(true);
    db.close();
  });

  test("searches a bounded number of words, and says what it dropped", () => {
    const db = seeded();
    const result = ask(db, { arg: `checkout ${"word ".repeat(40)}` });
    expect(result.denominator).toContain("Only the first 16 words were searched");
    expect(result.denominator).toContain("25 more were dropped");
    db.close();
  });

  test("refuses no words, or only whitespace, as a usage error", () => {
    const db = seeded();
    const usage = expect.objectContaining({ code: "usage", message: 'usage: dim q search "<words>"' });
    expect(() => ask(db, {})).toThrow(usage);
    expect(() => ask(db, { arg: "   " })).toThrow(usage);
    db.close();
  });

  test("a word nobody typed reads as no evidence, not an empty table", () => {
    const db = seeded();
    const result = ask(db, { arg: "promulgate" });
    expect(result.rows).toEqual([]);
    expect(result.note).toContain("nothing matches promulgate");
    expect(result.note).toContain("a reminder the harness injected is nothing anyone said");
    db.close();
  });

  test("a message carrying more of the terms outranks one carrying fewer", () => {
    const db = seeded();
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
       VALUES ('m-strong', 's1', '2026-09-02T09:00:00Z', 'user', 'orchard bramble candlewick driftwood', '/f.jsonl', 10)`,
    );
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
       VALUES ('m-weak', 's1', '2026-09-02T09:05:00Z', 'user', 'orchard alone', '/f.jsonl', 11)`,
    );
    const result = ask(db, { arg: "orchard bramble candlewick driftwood emberfall" });
    expect(result.rows.length).toBe(2);
    const strongIndex = result.rows.findIndex((r) => String(r[6]).includes("bramble"));
    const weakIndex = result.rows.findIndex((r) => String(r[6]).includes("alone"));
    expect(strongIndex).toBeLessThan(weakIndex);
    expect(result.rows[strongIndex]?.[5]).toBe("4/5");
    expect(result.rows[weakIndex]?.[5]).toBe("1/5");
    db.close();
  });

  test("a tie on matched count and relevance falls back to recency", () => {
    const db = seeded();
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
       VALUES ('m-early', 's1', '2026-09-02T09:00:00Z', 'user', 'thistledown', '/f.jsonl', 10)`,
    );
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
       VALUES ('m-late', 's1', '2026-09-02T09:05:00Z', 'user', 'thistledown', '/f.jsonl', 11)`,
    );
    const result = ask(db, { arg: "thistledown" });
    expect(result.rows.map((r) => String(r[1]))).toEqual(["2026-09-02T09:05", "2026-09-02T09:00"]);
    db.close();
  });

  test("relevance breaks a tie in matched-term count before recency does", () => {
    const db = seeded();
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
       VALUES ('m-terse', 's1', '2026-09-02T09:00:00Z', 'user', 'candlewick driftwood', '/f.jsonl', 10)`,
    );
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
       VALUES ('m-diluted', 's1', '2026-09-02T09:05:00Z', 'user', ?, '/f.jsonl', 11)`,
      [`candlewick driftwood ${"filler ".repeat(60)}`],
    );
    const result = ask(db, { arg: "candlewick driftwood" });
    expect(result.rows.map((r) => String(r[5]))).toEqual(["2/2", "2/2"]);
    expect(String(result.rows[0]?.[1])).toBe("2026-09-02T09:00");
    db.close();
  });

  test("the denominator states the ranking", () => {
    const db = seeded();
    const result = ask(db, { arg: "checkout" });
    expect(result.denominator).toContain(
      "ranked by how many of the 1 terms matched, ties broken by relevance then recency",
    );
    db.close();
  });

  test("a term matching nothing anyone said is named, not just dropped from the rows", () => {
    const db = seeded();
    const result = ask(db, { arg: "checkout zzznoword" });
    expect(result.denominator).toContain("This term matched nothing anyone said in this window: zzznoword");
    expect(result.rows.map((r) => String(r[0]))).toEqual(["s1"]);
    expect(result.rows[0]?.[5]).toBe("1/2");
    db.close();
  });

  test("a term found only in a meta message is still named missing, not credited as a match", () => {
    const db = seeded();
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, is_meta, src_file, src_line)
       VALUES ('m-injected', 's1', '2026-09-02T09:00:00Z', 'user', 'zzzmetaword', 1, '/f.jsonl', 12)`,
    );
    const result = ask(db, { arg: "checkout zzzmetaword" });
    expect(result.denominator).toContain("This term matched nothing anyone said in this window: zzzmetaword");
    expect(result.rows.every((r) => !String(r[6]).includes("zzzmetaword"))).toBe(true);
    db.close();
  });
});

describe("thread", () => {
  test("reads a session whose own id holds an at-sign", () => {
    const db = seeded();
    const id = "a0064e811b74a81cb@79e9c9bc-3a0b-46f6-b935-7a25be925124";
    db.run(
      `INSERT INTO session (id, tool, cwd, project, started_at, last_seen_at)
       VALUES (?, 'claude', '/w', '/home/code/dim-factory', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')`,
      [id],
    );
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
       VALUES ('m-sub', ?, '2026-09-01T10:45:00.000Z', 'assistant', 'What the delegate settled.', '/f.jsonl', 3)`,
      [id],
    );
    const thread = findQuery("thread") as NonNullable<ReturnType<typeof findQuery>>;
    const whole = thread.run(db, { ...ctx, arg: id });
    expect(whole.denominator).toContain("1 messages anyone said");
    expect(whole.denominator).not.toContain("centered on");

    const passage = thread.run(db, { ...ctx, arg: `${id}@2026-09-01T10:45:00.000Z` });
    expect(passage.denominator).toContain("centered on 2026-09-01T10:45:00.000Z");
    expect(passage.rows.length).toBe(1);
    db.close();
  });
});
