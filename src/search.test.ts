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
