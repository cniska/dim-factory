import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EMBED_DIMS, type Embedder, type Question } from "./embed";
import { buildIndex } from "./embed-index";
import { findQuery } from "./queries";
import type { QueryContext, QueryResult } from "./query";
import { SCHEMA_SQL } from "./schema";

const AUTHOR = "Distilling Person";

const HANDOFF = `# Handoff — dim-factory: reach a session unasked

## Next
Undo what an agent wrote without touching the user's own checkout.
`;

const SUBJECT = "feat: shadow git keeps the users index clean";

const search = findQuery("search") as NonNullable<ReturnType<typeof findQuery>>;

const byWords: Embedder = async (texts) =>
  texts.map((text) => {
    const v = new Float32Array(EMBED_DIMS);
    for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let at = 0;
      for (let i = 0; i < word.length; i++) at = (at * 31 + word.charCodeAt(i)) % EMBED_DIMS;
      v[at] = 1;
    }
    let sum = 0;
    for (const x of v) sum += x * x;
    const length = Math.sqrt(sum) || 1;
    for (let i = 0; i < EMBED_DIMS; i++) v[i] = (v[i] as number) / length;
    return v;
  });

async function asked(text: string): Promise<Question> {
  const [vector] = await byWords([text]);
  return { vector: vector as Float32Array };
}

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
     VALUES ('m-handoff', 's1', '2026-09-01T10:30:00Z', 'assistant', ?, '/f.jsonl', 1)`,
    [HANDOFF],
  );
  db.run(
    `INSERT INTO factory_handoff (message_id, session_id, role, ts, title, next)
     VALUES ('m-handoff', 's1', 'assistant', '2026-09-01T10:30:00Z',
             '# Handoff — dim-factory: reach a session unasked',
             'Undo what an agent wrote without touching the user''s own checkout.')`,
  );
  db.run(
    `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line, is_meta)
     VALUES ('m-meta', 's1', '2026-09-01T10:31:00Z', 'user', ?, '/f.jsonl', 2, 1)`,
    ["Injected reminder about the checkout."],
  );
  db.run(
    `INSERT INTO repo_commit (sha, repo, label, ts, author, subject, kind)
     VALUES ('abc1230000', '/r', 'cniska/dim-factory', '2026-09-01T09:00:00Z', ?, ?, 'feat')`,
    [AUTHOR, SUBJECT],
  );
  return db;
}

async function indexed(): Promise<Database> {
  const db = seeded();
  await buildIndex(db, byWords, AUTHOR);
  return db;
}

const run = (db: Database, ctx: QueryContext): QueryResult => search.run(db, { home: "/home", ...ctx });

describe("search degrades instead of failing", () => {
  test("falls back to keywords when nothing is embedded, and says which index answered", async () => {
    const db = seeded();
    const result = run(db, { arg: "shadow", question: await asked("shadow") });
    expect(result.denominator).toContain("keywords over");
    expect(result.denominator).toContain("nothing is embedded in this window");
    expect(result.columns).toEqual(["session", "when", "role", "project", "terms", "text"]);
    db.close();
  });

  test("falls back on a database older than the embedding table", async () => {
    const db = await indexed();
    db.run("DROP TABLE embedding");
    const result = run(db, { arg: "handoff", question: await asked("handoff") });
    expect(result.denominator).toContain("keywords over");
    expect(result.denominator).toContain("predates");
    db.close();
  });

  test("names the branch that answered as a value, not only in prose", async () => {
    const cold = seeded();
    expect(run(cold, { arg: "shadow", question: await asked("shadow") }).path).toBe("keyword");
    cold.close();

    const warm = await indexed();
    expect(run(warm, { arg: "handoff", question: await asked("handoff") }).path).toBe("cosine");
    expect(run(warm, { arg: "handoff", question: { unavailable: "no weights" } }).path).toBe("keyword");
    warm.close();
  });

  test("a model that would not load degrades to keywords, carrying the reason", async () => {
    const db = await indexed();
    const result = run(db, { arg: "checkout", question: { unavailable: "no weights on disk" } });
    expect(result.denominator).toContain("keywords over");
    expect(result.denominator).toContain("no weights on disk");
    expect(result.rows.length).toBe(1);
    db.close();
  });

  test("the keyword fallback still finds the word that was typed", async () => {
    const db = seeded();
    const result = run(db, { arg: "checkout", question: await asked("checkout") });
    expect(result.rows.length).toBe(1);
    expect(String(result.rows[0]?.[0])).toBe("s1");
    db.close();
  });

  test("keywords match what someone said, not text injected into the session", async () => {
    const db = seeded();
    const result = run(db, { arg: "checkout", question: await asked("checkout") });
    expect(result.rows.map((r) => String(r[0]))).toEqual(["s1"]);
    expect(String(result.rows[0]?.[5])).not.toContain("Injected");
    expect(result.denominator).toContain("1 of 2 messages that carry text anyone said");
    db.close();
  });

  test("the window can leave nothing to rank", async () => {
    const db = await indexed();
    const result = run(db, {
      arg: "checkout",
      question: await asked("checkout"),
      since: "2027-01-01T00:00:00Z",
    });
    expect(result.denominator).toContain("nothing is embedded in this window");
    db.close();
  });

  test("no question at all is the caller's bug, not a silent keyword search", async () => {
    const db = await indexed();
    expect(() => run(db, { arg: "checkout" })).toThrow("must resolve ctx.question");
    db.close();
  });

  test("an empty question asks for one rather than ranking the whole corpus", async () => {
    const db = await indexed();
    const result = run(db, { question: await asked("") });
    expect(result.rows[0]?.[0]).toContain("usage:");
    db.close();
  });
});

describe("keywords, asked directly", () => {
  const keywords = findQuery("keywords") as NonNullable<ReturnType<typeof findQuery>>;
  const ask = (db: Database, ctx: QueryContext): QueryResult => keywords.run(db, { home: "/home", ...ctx });

  test("reaches a conversation on a database where search still ranks by meaning", async () => {
    const db = await indexed();
    expect(ask(db, { arg: "checkout" }).rows.map((r) => String(r[0]))).toEqual(["s1"]);
    expect(run(db, { arg: "checkout", question: await asked("checkout") }).path).toBe("cosine");
    db.close();
  });

  test("claims no branch, so a trace cannot read it as a fallback", async () => {
    const db = await indexed();
    expect(ask(db, { arg: "checkout" }).path).toBeUndefined();
    db.close();
  });

  test("ranks no meaning, and says where meaning and the exchange are", async () => {
    const db = await indexed();
    const { denominator } = ask(db, { arg: "checkout" });
    expect(denominator).toContain("dim q search");
    expect(denominator).toContain("dim q thread <session>@<when>");
    expect(denominator).not.toContain("Meaning was not ranked");
    db.close();
  });

  test("spans history, so an old decision is still reachable", async () => {
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

  test("finds what another agent said, which the harness only carried", async () => {
    const db = seeded();
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line, is_meta, origin_kind)
       VALUES ('m-peer', 's1', '2026-09-01T10:33:00Z', 'user', ?, '/f.jsonl', 4, 1, 'peer')`,
      ["Another Claude session sent a message: we decided against the second checkout."],
    );
    expect(ask(db, { arg: "decided" }).rows.map((r) => String(r[0]))).toEqual(["s1"]);
    db.close();
  });

  test("searches a bounded number of words, and says what it dropped", async () => {
    const db = await indexed();
    const result = ask(db, { arg: `checkout ${"word ".repeat(40)}` });
    expect(result.denominator).toContain("Only the first 16 words were searched");
    expect(result.denominator).toContain("25 more were dropped");
    db.close();
  });

  test("whitespace alone is not a search", async () => {
    const db = await indexed();
    expect(String(ask(db, { arg: "   " }).rows[0]?.[0])).toContain("nothing to search for");
    db.close();
  });

  test("does not ask the caller to embed the words", () => {
    expect(keywords.embedsArg).toBeFalsy();
  });

  test("asks for words rather than searching for nothing", async () => {
    const db = await indexed();
    expect(String(ask(db, {}).rows[0]?.[0])).toContain("usage:");
    db.close();
  });

  test("a word nobody typed reads as no evidence, not an empty table", async () => {
    const db = await indexed();
    const result = ask(db, { arg: "promulgate" });
    expect(result.rows).toEqual([]);
    expect(result.note).toContain("nothing matches promulgate");
    expect(result.note).toContain("a reminder the harness injected is nothing anyone said");
    db.close();
  });

  test("a message carrying more of the terms outranks one carrying fewer, and returns rows rather than nothing", async () => {
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
    const strongIndex = result.rows.findIndex((r) => String(r[5]).includes("bramble"));
    const weakIndex = result.rows.findIndex((r) => String(r[5]).includes("alone"));
    expect(strongIndex).toBeLessThan(weakIndex);
    expect(result.rows[strongIndex]?.[4]).toBe("4/5");
    expect(result.rows[weakIndex]?.[4]).toBe("1/5");
    db.close();
  });

  test("a tie on matched count and relevance falls back to recency", async () => {
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

  test("relevance breaks a tie in matched-term count before recency does", async () => {
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
    expect(result.rows.map((r) => String(r[4]))).toEqual(["2/2", "2/2"]);
    expect(String(result.rows[0]?.[1])).toBe("2026-09-02T09:00");
    db.close();
  });

  test("the denominator states the ranking", async () => {
    const db = seeded();
    const result = ask(db, { arg: "checkout" });
    expect(result.denominator).toContain(
      "ranked by how many of the 1 terms matched, ties broken by relevance then recency",
    );
    db.close();
  });

  test("a term matching nothing anyone said is named, not just dropped from the rows", async () => {
    const db = seeded();
    const result = ask(db, { arg: "checkout zzznoword" });
    expect(result.denominator).toContain("This term matched nothing anyone said in this window: zzznoword");
    expect(result.rows.map((r) => String(r[0]))).toEqual(["s1"]);
    expect(result.rows[0]?.[4]).toBe("1/2");
    db.close();
  });

  test("a term found only in a meta message is still named missing, not credited as a match", async () => {
    const db = seeded();
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, is_meta, src_file, src_line)
       VALUES ('m-injected', 's1', '2026-09-02T09:00:00Z', 'user', 'zzzmetaword', 1, '/f.jsonl', 12)`,
    );
    const result = ask(db, { arg: "checkout zzzmetaword" });
    expect(result.denominator).toContain("This term matched nothing anyone said in this window: zzzmetaword");
    expect(result.rows.every((r) => !String(r[5]).includes("zzzmetaword"))).toBe(true);
    db.close();
  });
});

describe("search over the distilled index", () => {
  test("ranks by meaning and reports the index it ranked over", async () => {
    const db = await indexed();
    const result = run(db, { arg: SUBJECT, question: await asked(SUBJECT) });
    expect(result.denominator).toContain("cosine over 2 distilled passages");
    expect(result.columns).toEqual(["score", "kind", "when", "ref", "where", "text"]);
    expect(result.rows[0]?.[1]).toBe("subject");
    expect(result.rows[0]?.[4]).toBe("cniska/dim-factory");
    expect(result.rows[0]?.[5]).toBe(SUBJECT);
    db.close();
  });

  test("the closest passage comes first, whatever its date", async () => {
    const db = await indexed();
    const result = run(db, {
      arg: "undo what an agent wrote",
      question: await asked("undo what an agent wrote"),
    });
    expect(result.rows[0]?.[1]).toBe("next");
    expect(Number(result.rows[0]?.[0])).toBeGreaterThan(Number(result.rows[1]?.[0]));
    db.close();
  });

  test("a next names the passage, and the ref is what thread reads", async () => {
    const db = await indexed();
    const result = run(db, { arg: "touching the checkout", question: await asked("touching the checkout") });
    const next = result.rows.find((r) => r[1] === "next");
    expect(next?.[3]).toBe("s1@2026-09-01T10:30:00Z");
    expect(next?.[2]).toBe("2026-09-01T10:30");
    expect(next?.[4]).toBe("code/dim-factory");

    const thread = findQuery("thread") as NonNullable<ReturnType<typeof findQuery>>;
    const around = thread.run(db, { arg: String(next?.[3]) });
    expect(around.denominator).toContain("centered on 2026-09-01T10:30:00Z");
    expect(around.rows.length).toBeGreaterThan(0);
    db.close();
  });

  test("thread reads a session whose own id holds an at-sign", async () => {
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
    const whole = thread.run(db, { arg: id });
    expect(whole.denominator).toContain("1 messages anyone said");
    expect(whole.denominator).not.toContain("centered on");

    const passage = thread.run(db, { arg: `${id}@2026-09-01T10:45:00.000Z` });
    expect(passage.denominator).toContain("centered on 2026-09-01T10:45:00.000Z");
    expect(passage.rows.length).toBe(1);
    db.close();
  });

  test("a commit is named by its sha, which carries no passage", async () => {
    const db = await indexed();
    const result = run(db, { arg: SUBJECT, question: await asked(SUBJECT) });
    const subject = result.rows.find((r) => r[1] === "subject");
    expect(subject?.[3]).toBe("abc12300");
    db.close();
  });

  test("a hit sharing no word with the question still ranks", async () => {
    const db = await indexed();
    const result = run(db, { arg: "shadow", question: await asked("shadow") });
    expect(result.rows.length).toBe(2);
    expect(result.rows.some((r) => r[1] === "next")).toBe(true);
    db.close();
  });

  test("a passage of several lines is cut to one", async () => {
    const db = await indexed();
    db.run("UPDATE embedding SET text = ? WHERE kind = 'next'", [`${"word\n".repeat(60)}end`]);
    const result = run(db, { arg: "undo", question: await asked("undo") });
    const text = String(result.rows.find((r) => r[1] === "next")?.[5]);
    expect(text).not.toContain("\n");
    expect(text.endsWith("…")).toBe(true);
    db.close();
  });

  test("a repo with no remote is named by its tail, so one row cannot widen every row", async () => {
    const db = await indexed();
    const scratch = "/private/tmp/claude-501/a-very-long-scratch-directory/runs/run-103";
    db.run("UPDATE repo_commit SET label = NULL, repo = ? WHERE sha = 'abc1230000'", [scratch]);
    const result = run(db, { arg: SUBJECT, question: await asked(SUBJECT) });
    const where = String(result.rows.find((r) => r[1] === "subject")?.[4]);
    expect(where.length).toBeLessThanOrEqual(30);
    expect(where).toBe("…cratch-directory/runs/run-103");
    db.close();
  });

  test("a vector another model built is not scored beside this one's", async () => {
    const db = await indexed();
    expect(
      (db.query("SELECT model FROM embedding WHERE kind = 'next'").get() as { model: string }).model,
    ).toBe("Xenova/all-MiniLM-L6-v2");
    db.run("UPDATE embedding SET model = 'retired/model' WHERE kind = 'subject'");

    const result = run(db, { arg: SUBJECT, question: await asked(SUBJECT) });
    expect(result.rows.map((r) => r[1])).toEqual(["next"]);
    expect(result.denominator).toContain("cosine over 1 distilled passages");
    expect(result.denominator).toContain("1 in this window built by another model");
    db.close();
  });

  test("an index left entirely on another model's scale degrades to keywords", async () => {
    const db = await indexed();
    db.run("UPDATE embedding SET model = 'retired/model'");
    const result = run(db, { arg: "checkout", question: await asked("checkout") });
    expect(result.path).toBe("keyword");
    expect(result.denominator).toContain("another model");
    db.close();
  });

  test("the note says what the index does not hold, so a miss is not read as an absence", async () => {
    const db = await indexed();
    const result = run(db, { arg: "shadow", question: await asked("shadow") });
    expect(result.note).toContain("no raw");
    db.close();
  });
});
