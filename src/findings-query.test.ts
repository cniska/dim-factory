import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type Finding, recordFinding } from "./finding";
import { findQuery } from "./queries";
import type { QueryContext } from "./query";
import { SCHEMA_SQL } from "./schema";

const ctx: QueryContext = { home: "/h" };

const raised = (over: Partial<Finding> = {}): Finding => ({
  repo: "cniska/dim-factory",
  slice: "the finding table",
  dimension: "untested invariant",
  file: "src/finding.ts",
  summary: "a blank reason reached the database",
  answer: "fixed" as const,
  reason: null,
  ...over,
});

function seeded(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

const findings = () => {
  const query = findQuery("findings");
  if (!query) throw new Error("findings is not registered");
  return query;
};

describe("reading findings back", () => {
  test("is a named question, so `q list` offers it", () => {
    expect(findings().name).toBe("findings");
  });

  test("spans history, because a window would hide a table that fills a slice at a time", () => {
    expect(findings().spansHistory).toBe(true);
  });

  test("says nothing was recorded rather than printing a zero", () => {
    const db = seeded();
    const result = findings().run(db, ctx);
    expect(result.rows).toEqual([]);
    expect(result.denominator).toBe("no finding has been recorded");
    db.close();
  });

  test("counts a fix and a refusal separately under one dimension", () => {
    const db = seeded();
    recordFinding(db, raised());
    recordFinding(db, raised({ answer: "refused", reason: "belongs to the next slice" }));
    const result = findings().run(db, ctx);
    expect(result.rows).toEqual([["untested invariant", 2, 1, 1, 1, 1]]);
    db.close();
  });

  test("states the base its numbers came from", () => {
    const db = seeded();
    recordFinding(db, raised());
    recordFinding(db, raised({ slice: "the query", dimension: "doc unchanged" }));
    expect(findings().run(db, ctx).denominator).toBe("2 findings answered across 2 slices (all time)");
    db.close();
  });

  test("counts one slice as a slice", () => {
    const db = seeded();
    recordFinding(db, raised());
    expect(findings().run(db, ctx).denominator).toBe("1 findings answered across 1 slice (all time)");
    db.close();
  });

  test("ranks the dimension raised most often first", () => {
    const db = seeded();
    recordFinding(db, raised({ dimension: "doc unchanged" }));
    recordFinding(db, raised());
    recordFinding(db, raised({ slice: "the query" }));
    const result = findings().run(db, ctx);
    expect(result.rows.map((row) => row[0])).toEqual(["untested invariant", "doc unchanged"]);
    db.close();
  });

  test("counts only what the window covers, so the base it prints is true", () => {
    const db = seeded();
    recordFinding(db, raised());
    db.run("UPDATE finding SET recorded_at = '2020-01-01T00:00:00Z'");
    recordFinding(db, raised({ slice: "the query", dimension: "doc unchanged" }));
    const result = findings().run(db, { ...ctx, since: "2021-01-01T00:00:00Z" });
    expect(result.rows).toEqual([["doc unchanged", 1, 1, 0, 1, 1]]);
    expect(result.denominator).toBe("1 findings answered across 1 slice (since 2021-01-01)");
    db.close();
  });

  test("says a fragment matched nothing rather than printing an empty table", () => {
    const db = seeded();
    recordFinding(db, raised());
    const result = findings().run(db, { ...ctx, arg: "zzz" });
    expect(result.rows).toEqual([]);
    expect(result.denominator).toBe("no finding recorded against a repo matching zzz");
    db.close();
  });

  test("names the window when one emptied the table, not the corpus", () => {
    const db = seeded();
    recordFinding(db, raised());
    const result = findings().run(db, { ...ctx, since: "2099-01-01T00:00:00Z" });
    expect(result.rows).toEqual([]);
    expect(result.denominator).toBe("no finding has been recorded since 2099-01-01");
    db.close();
  });

  test("offers the repo fragment on the discovery surface", () => {
    expect(findings().usage).toBe("dim q findings [repo-fragment]");
  });

  test("narrows to one repo when given a fragment", () => {
    const db = seeded();
    recordFinding(db, raised());
    recordFinding(db, raised({ repo: "cniska/acolyte", dimension: "doc unchanged" }));
    const result = findings().run(db, { ...ctx, arg: "acolyte" });
    expect(result.rows).toEqual([["doc unchanged", 1, 1, 0, 1, 1]]);
    db.close();
  });
});
