import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { repoConvention } from "./commit-convention";
import { SCHEMA_SQL } from "./schema";

function database(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

function add(
  db: Database,
  repo: string,
  label: string | null,
  sha: string,
  subject: string,
  kind: string | null,
): void {
  db.run(
    "INSERT INTO repo_commit (sha, repo, label, ts, author, subject, kind) VALUES (?, ?, ?, '2026-01-01T00:00:00Z', 'a', ?, ?)",
    [sha, repo, label, subject, kind],
  );
}

describe("a repository's recorded commit convention", () => {
  test("reads the exact repository's log, its worktrees folded in and a similarly named repository left out", () => {
    const db = database();
    for (let i = 0; i < 10; i++) {
      add(db, "/h/code/one", "owner/one", `a${i}`, "feat: a conforming subject", "feat");
      const [subject, kind] =
        i < 8 ? [`fix: ${"a".repeat(60)}`, "fix"] : ["feat: a conforming subject", "feat"];
      add(db, "/h/code/one/.claude/worktrees/wt", "owner/one", `w${i}`, subject, kind);
    }
    for (let i = 0; i < 30; i++) {
      add(db, "/h/code/one-old", "owner/one-old", `o${i}`, "docs: another repository", "docs");
    }

    expect(repoConvention(db, { label: "owner/one", root: "/h/code/one" })).toEqual({
      commits: 20,
      observed: {
        conventionalPct: 100,
        meanLength: 42,
        over50Pct: 40,
        squashedPct: 0,
        topKinds: ["feat", "fix"],
      },
    });
    db.close();
  });

  test("keys a repository with no remote by its folded checkout path", () => {
    const db = database();
    for (let i = 0; i < 10; i++) {
      add(db, "/h/code/three", null, `c${i}`, "feat: a conforming subject", "feat");
      add(db, "/h/code/three/.claude/worktrees/wt", null, `d${i}`, "a plain subject", null);
      add(db, "/h/code/three-copy", null, `e${i}`, "feat: elsewhere", "feat");
    }

    expect(repoConvention(db, { label: null, root: "/h/code/three" })).toMatchObject({
      commits: 20,
      observed: { conventionalPct: 50, topKinds: ["feat"] },
    });
    db.close();
  });

  test("reports how many commits it read when there are too few to call a convention", () => {
    const db = database();
    for (let i = 0; i < 19; i++) add(db, "/h/code/one", "owner/one", `a${i}`, "feat: x", "feat");

    expect(repoConvention(db, { label: "owner/one", root: "/h/code/one" })).toEqual({
      commits: 19,
      observed: null,
    });
    expect(repoConvention(db, { label: "owner/none", root: "/h/code/none" })).toEqual({
      commits: 0,
      observed: null,
    });
    db.close();
  });

  test("lets a database error through rather than reading it as no history", () => {
    const db = new Database(":memory:");

    expect(() => repoConvention(db, { label: "owner/one", root: "/h/code/one" })).toThrow("repo_commit");
    db.close();
  });
});
