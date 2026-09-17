import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EMBED_DIMS, type Embedder, type Question } from "./embed";
import { buildIndex } from "./embed-index";
import { findQuery, type QueryContext, type QueryResult } from "./queries";
import { SCHEMA_SQL } from "./schema";

const AUTHOR = "Distilling Person";

const HANDOFF = `# Handoff — dim-factory: reach a session unasked

## Next
Undo what an agent wrote without touching the user's own checkout.
`;

const SUBJECT = "feat: shadow git keeps the users index clean";

const search = findQuery("search") as NonNullable<ReturnType<typeof findQuery>>;

/**
 * One dimension per word, so a passage's vector is the set of words in it and a
 * cosine is their overlap. Deterministic, and no weights have to be on disk.
 */
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
    expect(result.columns).toEqual(["session", "when", "role", "project", "text"]);
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

  // The denominator says which index answered in prose; `path` is the value the
  // trace records, and only it can tell a fallback from a cosine run afterwards.
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
    expect(String(result.rows[0]?.[4])).not.toContain("Injected");
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

  // The whole point of the door: it answers on a database where `search` ranks
  // by meaning, rather than only where the meaning path has broken.
  test("reaches a conversation on a database where search still ranks by meaning", async () => {
    const db = await indexed();
    expect(ask(db, { arg: "checkout" }).rows.map((r) => String(r[0]))).toEqual(["s1"]);
    expect(run(db, { arg: "checkout", question: await asked("checkout") }).path).toBe("cosine");
    db.close();
  });

  // `path` names the branch that answered where a query has more than one. This
  // one has a single branch, and `command_trace` keeps the column: a value here
  // would read in the trace as `search` having degraded.
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

  // Without this the door windows to 30 days, and a decision settled months ago
  // is unreachable — which is the whole thing it was built to reach.
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

  // Relayed through the harness, so flagged meta, but an agent wrote it — and a
  // question about what was decided wants exactly these.
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

  // An argument can arrive from a file or a transcript, and the cost of ANDing
  // phrases is superlinear, so an uncapped one runs until someone kills it.
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

  // Words are the whole answer here, so embedding the argument would load a
  // model to rank nothing — the one cost this door has that `search` does not.
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

  test("a next carries its session and time, so the thread can be read around it", async () => {
    const db = await indexed();
    const result = run(db, { arg: "touching the checkout", question: await asked("touching the checkout") });
    const next = result.rows.find((r) => r[1] === "next");
    expect(next?.[3]).toBe("s1");
    expect(next?.[2]).toBe("2026-09-01T10:30");
    expect(next?.[4]).toBe("code/dim-factory");
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

  test("the note says what the index does not hold, so a miss is not read as an absence", async () => {
    const db = await indexed();
    const result = run(db, { arg: "shadow", question: await asked("shadow") });
    expect(result.note).toContain("no raw");
    db.close();
  });
});
