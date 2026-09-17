import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runBench } from "./bench";
import type { BenchQuestion } from "./bench-corpus";
import { EMBED_DIMS, type Embedder, type Question } from "./embed";
import { buildIndex } from "./embed-index";
import { SCHEMA_SQL } from "./schema";

const embedNothing = async (): Promise<Question | undefined> => undefined;

/** One dimension per word, so a cosine is word overlap and no weights are needed. */
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

const embedWith = async (text: string): Promise<Question> => {
  const [vector] = await byWords([text]);
  return { vector: vector as Float32Array };
};

const graded = (query: string, relevant: [string, number][]): BenchQuestion => ({
  id: "q1",
  query,
  question: "anything",
  relevant: new Map(relevant),
});

/**
 * A stand-in query, registered the way every query is, so the runner is exercised
 * through the registry rather than around it.
 */
function seeded(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  db.run(
    `INSERT INTO session (id, tool, cwd, project, started_at, last_seen_at)
     VALUES ('s1', 'claude', '/w', '/p', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')`,
  );
  db.run(
    `INSERT INTO source_file (path, tool, kind, session_id) VALUES ('/f.jsonl', 'claude', 'transcript', 's1')`,
  );
  db.run(
    `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
     VALUES ('m1', 's1', '2026-09-01T10:30:00Z', 'user', 'a decision about the shadow checkout', '/f.jsonl', 1)`,
  );
  const commits: [string, string][] = [
    ["aaaa111122223333444455556666777788889999", "feat: the one that answers"],
    ["bbbb111122223333444455556666777788889999", "feat: the one that does not"],
  ];
  for (const [sha, subject] of commits) {
    db.run(
      `INSERT INTO repo_commit (sha, repo, label, ts, author, subject, kind)
       VALUES (?, '/r', 'cniska/dim-factory', '2026-09-01T09:00:00Z', 'A Person', ?, 'feat')`,
      [sha, subject],
    );
  }
  return db;
}

describe("scoring the corpus through the queries themselves", () => {
  // `keywords` prints a session and a timestamp and no ref, so its ranking
  // cannot be scored. Saying so beats scoring less than the corpus claims.
  test("reports a query whose rows name no ref, rather than skipping it", async () => {
    const db = seeded();
    const report = await runBench(db, [graded("keywords", [["m1", 3]])], 5, {}, embedNothing);
    expect(report.scores).toEqual([]);
    expect(report.unscorable).toEqual([{ id: "q1", why: "keywords prints no ref column to score against" }]);
    db.close();
  });

  // With nothing scored there is no mean, and a NaN printed as a score is worse
  // than a refusal: it reads as a measurement.
  test("a corpus nothing could score reports no mean, not a NaN", async () => {
    const db = seeded();
    const report = await runBench(db, [graded("keywords", [["m1", 3]])], 5, {}, embedNothing);
    expect(report.recall).toBe(0);
    expect(Number.isNaN(report.ndcg)).toBe(false);
    db.close();
  });

  // A message is printed by its session, so grading it by its own message id
  // would score zero for ever and read as a ranking failure.
  test("refuses a label that names neither a commit nor a session", async () => {
    const db = seeded();
    await buildIndex(db, byWords, "A Person");
    const report = await runBench(db, [graded("search", [["m1", 3]])], 5, {}, embedWith);
    expect(report.scores).toEqual([]);
    expect(report.unscorable[0]?.why).toContain("names no commit and no session");
    db.close();
  });

  test("refuses two graded rows that print the same ref", async () => {
    const db = seeded();
    await buildIndex(db, byWords, "A Person");
    const both = graded("search", [
      ["aaaa111122223333444455556666777788889999", 3],
      ["aaaa111199998888777766665555444433332222", 2],
    ]);
    db.run(
      `INSERT INTO repo_commit (sha, repo, label, ts, author, subject, kind)
       VALUES ('aaaa111199998888777766665555444433332222', '/r', 'cniska/dim-factory',
               '2026-09-01T09:00:00Z', 'A Person', 'feat: a twin', 'feat')`,
    );
    const report = await runBench(db, [both], 5, {}, embedWith);
    expect(report.unscorable[0]?.why).toContain("print the same ref");
    db.close();
  });

  // Without the cutoff reaching the metrics, k is decoration and every score is
  // measured over whatever the query happened to return.
  test("the cutoff reaches the score", async () => {
    const db = seeded();
    await buildIndex(db, byWords, "A Person");
    const asked = { ...graded("search", [["bbbb111122223333444455556666777788889999", 3]]) };
    asked.question = "the one that answers";
    const wide = await runBench(db, [asked], 10, {}, embedWith);
    const narrow = await runBench(db, [asked], 1, {}, embedWith);
    expect(wide.scores[0]?.recall).toBe(1);
    expect(narrow.scores[0]?.recall).toBe(0);
    db.close();
  });

  test("a question naming no known query is reported, not silently dropped", async () => {
    const db = seeded();
    const report = await runBench(db, [graded("telepathy", [["x", 3]])], 5, {}, embedNothing);
    expect(report.unscorable[0]?.why).toContain("telepathy");
    db.close();
  });

  // The corpus stores a full sha and a query prints a short one; scoring at the
  // printed width is what makes a labeled row and a returned row the same row.
  test("matches a labeled ref against the shortened one a query prints", async () => {
    const db = seeded();
    await buildIndex(db, byWords, "A Person");
    const answers = { ...graded("search", [["aaaa111122223333444455556666777788889999", 3]]) };
    answers.question = "the one that answers";
    const report = await runBench(db, [answers], 5, {}, embedWith);
    expect(report.unscorable).toEqual([]);
    expect(report.scores[0]?.recall).toBe(1);
    expect(report.scores[0]?.ndcg).toBe(1);
    db.close();
  });
});
