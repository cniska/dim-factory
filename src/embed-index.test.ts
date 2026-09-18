import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readDistilled } from "./distilled";
import { EMBED_DIMS, type Embedder, fromBlob, similarity } from "./embed";
import { buildIndex } from "./embed-index";
import { SCHEMA_SQL } from "./schema";

const AUTHOR = "Distilling Person";

const HANDOFF = `# Handoff — dim-factory: earn the first cut

## Next
Get the shared commit gate installed, then delete the rule it holds.

## What the next move needs
- Something that must not reach the block.
`;

/** Deterministic and unit length, so the index can be tested without a model on disk. */
const fake: Embedder = async (texts) =>
  texts.map((text) => {
    const v = new Float32Array(EMBED_DIMS);
    for (let i = 0; i < text.length; i++) {
      v[i % EMBED_DIMS] = (v[i % EMBED_DIMS] as number) + text.charCodeAt(i);
    }
    let sum = 0;
    for (const x of v) sum += x * x;
    const length = Math.sqrt(sum) || 1;
    for (let i = 0; i < EMBED_DIMS; i++) v[i] = (v[i] as number) / length;
    return v;
  });

function seeded(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  db.run(
    `INSERT INTO session (id, tool, cwd, started_at, last_seen_at)
     VALUES ('s1', 'claude', '/w', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')`,
  );
  db.run(
    `INSERT INTO source_file (path, tool, kind, session_id) VALUES ('/f.jsonl', 'claude', 'transcript', 's1')`,
  );
  const message = (id: string, role: string, text: string) =>
    db.run(
      `INSERT INTO message (id, session_id, ts, role, text, src_file, src_line)
       VALUES (?, 's1', '2026-09-01T10:30:00Z', ?, ?, '/f.jsonl', 1)`,
      [id, role, text],
    );
  message("m-handoff", "assistant", HANDOFF);
  message("m-stopped", "user", "no, the worktree convention has one definition");
  db.run(
    `INSERT INTO repo_commit (sha, repo, label, ts, author, subject, kind)
     VALUES ('abc123', '/r', 'cniska/dim-factory', '2026-09-01T09:00:00Z', ?, 'feat: wt ships and is tested here', 'feat')`,
    [AUTHOR],
  );
  db.run(
    `INSERT INTO repo_commit (sha, repo, label, ts, author, subject, kind)
     VALUES ('def456', '/r', 'upstream/thing', '2026-09-01T09:00:00Z', 'Someone Else', 'fix: not this persons work', 'fix')`,
  );
  return db;
}

const kinds = (db: Database): Record<string, number> =>
  Object.fromEntries(
    (
      db.query("SELECT kind, count(*) AS n FROM embedding GROUP BY kind").all() as {
        kind: string;
        n: number;
      }[]
    ).map((r) => [r.kind, r.n]),
  );

describe("what counts as distilled", () => {
  test("a handoff contributes its Next, not the whole message", () => {
    const db = seeded();
    const next = readDistilled(db, AUTHOR).find((d) => d.kind === "next");
    expect(next?.ref).toBe("m-handoff");
    expect(next?.text).toBe("Get the shared commit gate installed, then delete the rule it holds.");
    db.close();
  });

  test("only the subjects this person authored", () => {
    const db = seeded();
    const refs = readDistilled(db, AUTHOR)
      .filter((d) => d.kind === "subject")
      .map((d) => d.ref);
    expect(refs).toEqual(["abc123"]);
    db.close();
  });

  test("no subjects at all when git names nobody", () => {
    const db = seeded();
    expect(readDistilled(db, null).filter((d) => d.kind === "subject")).toEqual([]);
    db.close();
  });

  test("a stopped turn is not a correction until it is labeled", () => {
    const db = seeded();
    expect(readDistilled(db, AUTHOR).filter((d) => d.kind === "correction")).toEqual([]);
    db.run(
      `INSERT INTO correction_label (message_id, label, labeled_at)
       VALUES ('m-stopped', 'correction', '2026-09-02T00:00:00Z')`,
    );
    expect(readDistilled(db, AUTHOR).filter((d) => d.kind === "correction").length).toBe(1);
    db.close();
  });

  test("a clarification is not a correction", () => {
    const db = seeded();
    db.run(
      `INSERT INTO correction_label (message_id, label, labeled_at)
       VALUES ('m-stopped', 'clarification', '2026-09-02T00:00:00Z')`,
    );
    expect(readDistilled(db, AUTHOR).filter((d) => d.kind === "correction")).toEqual([]);
    db.close();
  });
});

describe("building the index", () => {
  test("embeds every distilled passage once", async () => {
    const db = seeded();
    const report = await buildIndex(db, fake, AUTHOR);
    expect(report.found).toEqual({ next: 1, subject: 1, correction: 0 });
    expect(report.embedded).toBe(2);
    expect(kinds(db)).toEqual({ next: 1, subject: 1 });
    db.close();
  });

  test("a stored vector is the full width and unit length", async () => {
    const db = seeded();
    await buildIndex(db, fake, AUTHOR);
    const row = db.query("SELECT vector FROM embedding WHERE kind = 'subject'").get() as {
      vector: Uint8Array;
    };
    expect(row.vector.byteLength).toBe(EMBED_DIMS * 4);
    const stored = fromBlob(row.vector);
    expect(Math.sqrt(similarity(stored, stored))).toBeCloseTo(1, 6);
    db.close();
  });

  test("a second run embeds nothing", async () => {
    const db = seeded();
    await buildIndex(db, fake, AUTHOR);
    const again = await buildIndex(db, fake, AUTHOR);
    expect(again.embedded).toBe(0);
    expect(again.unchanged).toBe(2);
    db.close();
  });

  test("rewriting the source text re-embeds that passage alone", async () => {
    const db = seeded();
    await buildIndex(db, fake, AUTHOR);
    db.run("UPDATE repo_commit SET subject = 'feat: wt ships with a different subject' WHERE sha = 'abc123'");
    const again = await buildIndex(db, fake, AUTHOR);
    expect(again.embedded).toBe(1);
    expect(again.unchanged).toBe(1);
    const row = db.query("SELECT text FROM embedding WHERE kind = 'subject'").get() as { text: string };
    expect(row.text).toBe("feat: wt ships with a different subject");
    db.close();
  });

  test("a passage whose source is gone is dropped, never left behind", async () => {
    const db = seeded();
    await buildIndex(db, fake, AUTHOR);
    db.run("DELETE FROM repo_commit WHERE sha = 'abc123'");
    const again = await buildIndex(db, fake, AUTHOR);
    expect(again.removed).toBe(1);
    expect(kinds(db)).toEqual({ next: 1 });
    db.close();
  });

  test("a label withdrawn takes its vector with it", async () => {
    const db = seeded();
    db.run(
      `INSERT INTO correction_label (message_id, label, labeled_at)
       VALUES ('m-stopped', 'correction', '2026-09-02T00:00:00Z')`,
    );
    await buildIndex(db, fake, AUTHOR);
    expect(kinds(db).correction).toBe(1);
    db.run("UPDATE correction_label SET label = 'not_correction' WHERE message_id = 'm-stopped'");
    const again = await buildIndex(db, fake, AUTHOR);
    expect(again.removed).toBe(1);
    expect(kinds(db).correction).toBeUndefined();
    db.close();
  });

  test("a model change re-embeds what a text change would not", async () => {
    const db = seeded();
    await buildIndex(db, fake, AUTHOR);
    db.run("UPDATE embedding SET model = 'some/older-model'");
    const again = await buildIndex(db, fake, AUTHOR);
    expect(again.embedded).toBe(2);
    expect(again.unchanged).toBe(0);
    db.close();
  });
});
