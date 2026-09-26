import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./command";
import { type Finding, findingFrom, parseFinding, recordFinding } from "./finding";
import { SCHEMA_SQL } from "./schema";
import { rebuild } from "./sync";

const answered: Finding = {
  repo: "cniska/dim-factory",
  slice: "the finding table",
  dimension: "comment narrates the change",
  file: "src/schema.ts",
  summary: "the header comment says what the table used to hold",
  answer: "fixed",
  reason: null,
};

function opened(): Database {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  return db;
}

describe("reading a finding off the command line", () => {
  const complete = [
    "--slice",
    "the finding table",
    "--dimension",
    "untested invariant",
    "--answer",
    "fixed",
    "--summary",
    "no test fails when the check is removed",
  ];

  test("takes each flag's value", () => {
    const given = parseFinding(complete);
    expect(given.get("--answer")).toBe("fixed");
    expect(given.get("--summary")).toBe("no test fails when the check is removed");
  });

  test("refuses a flag given twice rather than keeping one value", () => {
    expect(() => parseFinding([...complete, "--summary", "something else"])).toThrow(/given twice/);
  });

  test("refuses a flag with no value", () => {
    expect(() => parseFinding(["--slice", "--answer", "fixed"])).toThrow(/needs a value/);
  });

  test("refuses a flag it does not know", () => {
    expect(() => parseFinding([...complete, "--severity", "high"])).toThrow(/is not one of/);
  });

  test("names the missing flag rather than recording a partial row", () => {
    expect(() => findingFrom(complete.slice(0, 6), process.cwd())).toThrow(/--summary is required/);
  });

  test("refuses an answer that is neither a fix nor a refusal", () => {
    const args = [...complete.slice(0, 4), "--answer", "deferred", ...complete.slice(6)];
    expect(() => findingFrom(args, process.cwd())).toThrow(/fixed or refused/);
  });

  test("refuses a refusal with no reason, which is what ends a finding", () => {
    const args = [...complete.slice(0, 4), "--answer", "refused", ...complete.slice(6)];
    expect(() => findingFrom(args, process.cwd())).toThrow(/needs --why/);
  });

  test("refuses a refusal whose reason is only whitespace", () => {
    const args = [...complete.slice(0, 4), "--answer", "refused", ...complete.slice(6), "--why", "   "];
    expect(() => findingFrom(args, process.cwd())).toThrow(/needs --why/);
  });

  test("refuses a reason on a fix, so the two answers stay distinct", () => {
    expect(() => findingFrom([...complete, "--why", "it does not matter here"], process.cwd())).toThrow(
      /does not belong on a fix/,
    );
  });

  test("refuses a directory that is no checkout, rather than labeling the row by guess", () => {
    const outside = mkdtempSync(join(tmpdir(), "dim-finding-"));
    expect(() => findingFrom(complete, outside)).toThrow(UsageError);
  });
});

describe("the row a finding becomes", () => {
  test("a refusal keeps the reason it was refused with", () => {
    const db = opened();
    recordFinding(db, { ...answered, answer: "refused", reason: "true, and it belongs to the next slice" });
    expect(db.query("SELECT answer, reason FROM finding").get()).toEqual({
      answer: "refused",
      reason: "true, and it belongs to the next slice",
    });
    db.close();
  });

  test("the table refuses a refusal with a blank reason", () => {
    const db = opened();
    expect(() =>
      db.run(
        `INSERT INTO finding (repo, slice, dimension, summary, answer, reason, recorded_at)
         VALUES ('r', 's', 'd', 'sum', 'refused', '   ', '2026-09-18T00:00:00Z')`,
      ),
    ).toThrow();
    db.close();
  });

  test("the table refuses an answer outside the two", () => {
    const db = opened();
    expect(() =>
      db.run(
        `INSERT INTO finding (repo, slice, dimension, summary, answer, recorded_at)
         VALUES ('r', 's', 'd', 'sum', 'deferred', '2026-09-18T00:00:00Z')`,
      ),
    ).toThrow();
    db.close();
  });

  test("the repo and the file land in the columns the commit_file join reads", () => {
    const db = opened();
    recordFinding(db, answered);
    expect(db.query("SELECT repo, slice, dimension, file FROM finding").get()).toEqual({
      repo: "cniska/dim-factory",
      slice: "the finding table",
      dimension: "comment narrates the change",
      file: "src/schema.ts",
    });
    db.close();
  });

  test("several findings on one slice each keep their own row", () => {
    const db = opened();
    recordFinding(db, answered);
    recordFinding(db, {
      ...answered,
      dimension: "doc unchanged",
      summary: "design.md still names two tables",
    });
    expect(db.query("SELECT count(*) AS n FROM finding").get()).toEqual({ n: 2 });
    db.close();
  });
});

describe("what rebuild may not take", () => {
  test("a finding survives a rebuild, having no source to re-read", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-rebuild-"));
    const db = opened();
    recordFinding(db, answered);
    rebuild(db, { HOME: home, DIM_HOME: home });
    expect(db.query("SELECT summary FROM finding").get()).toEqual({ summary: answered.summary });
    db.close();
  });
});
