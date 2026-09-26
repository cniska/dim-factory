import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reviewOutput } from "./fixtures.test-support";
import { parseReviewReport, REVIEW_DIMENSIONS } from "./station-review-artifact";
import schema from "./station-review-artifact.schema.json";

const finding = {
  dimension: "correctness",
  file: "src/gate.ts",
  line: 12,
  failure: "The guard lets an empty token through.",
  fix: "Refuse an empty token before the lookup.",
  severity: "high",
};

const cleanCoverage = (except: Record<string, { status: string; reason: string | null }> = {}) =>
  REVIEW_DIMENSIONS.map((dimension) => ({ dimension, status: "clean", reason: null, ...except[dimension] }));

describe("the reviewer's report", () => {
  test("parses every section of a report", () => {
    const report = parseReviewReport(
      reviewOutput({
        findings: [finding],
        conformance: [{ kind: "missing", slice: "The gate", detail: "No refusal for ruling_pending." }],
        set_aside: [{ item: "the wall", why: "the plan keeps it read-only" }],
        unverified: [{ claim: "Codex accepts the schema", would_settle: "a Codex review run" }],
        observations: ["The helper name could be shorter."],
      }),
    );
    expect(report).toMatchObject({
      verdict: "The change does what the plan asked.",
      findings: [finding],
      conformance: [{ kind: "missing", slice: "The gate", detail: "No refusal for ruling_pending." }],
      setAside: [{ item: "the wall", why: "the plan keeps it read-only" }],
      unverified: [{ claim: "Codex accepts the schema", wouldSettle: "a Codex review run" }],
      observations: ["The helper name could be shorter."],
    });
    expect(report.coverage.find((entry) => entry.dimension === "correctness")?.status).toBe("findings");
  });

  test.each([
    ["invalid JSON", "not json", "reviewer output must be valid JSON"],
    ["an absent verdict", reviewOutput({ verdict: " " }), "reviewer output must contain a non-empty verdict"],
    [
      "absent findings",
      reviewOutput({ findings: undefined }),
      "reviewer output must contain a findings array",
    ],
    [
      "a finding with no file",
      reviewOutput({ findings: [{ ...finding, file: "" }] }),
      "reviewer finding 1 must contain a non-empty file",
    ],
    [
      "a finding with no line",
      reviewOutput({ findings: [{ ...finding, line: null }] }),
      "reviewer finding 1 must give line as a whole number from 1",
    ],
    [
      "a finding at line 0",
      reviewOutput({ findings: [{ ...finding, line: 0 }] }),
      "reviewer finding 1 must give line as a whole number from 1",
    ],
    [
      "a finding with no failure",
      reviewOutput({ findings: [{ ...finding, failure: " " }] }),
      "reviewer finding 1 must contain a non-empty failure",
    ],
    [
      "a finding with no fix",
      reviewOutput({ findings: [{ ...finding, fix: null }] }),
      "reviewer finding 1 must contain a non-empty fix",
    ],
    [
      "a finding that does not block",
      reviewOutput({ findings: [{ ...finding, severity: "low" }] }),
      'reviewer finding 1 has severity "low"; every finding blocks at critical, high or medium, and a point that does not block belongs in observations',
    ],
    [
      "a finding outside the dimensions",
      reviewOutput({ findings: [{ ...finding, dimension: "vibes" }] }),
      'reviewer finding 1 has dimension "vibes", which is not one of plan, correctness, tests, architecture, maintainability, docs, security, performance, style',
    ],
    [
      "four observations",
      reviewOutput({ observations: ["a", "b", "c", "d"] }),
      "reviewer output holds 4 observations, and at most 3 are kept",
    ],
    [
      "coverage clean where a finding carries the dimension",
      reviewOutput({ findings: [finding], coverage: cleanCoverage() }),
      "reviewer coverage of correctness is clean, but a finding carries correctness",
    ],
    [
      "coverage reporting findings no finding carries",
      reviewOutput({ coverage: cleanCoverage({ docs: { status: "findings", reason: null } }) }),
      "reviewer coverage of docs is findings, but no finding carries docs",
    ],
    [
      "coverage missing a dimension",
      reviewOutput({ coverage: cleanCoverage().filter((entry) => entry.dimension !== "style") }),
      "reviewer coverage must hold exactly one entry for style, and holds 0",
    ],
    [
      "coverage naming a dimension twice",
      reviewOutput({ coverage: [...cleanCoverage(), { dimension: "tests", status: "clean", reason: null }] }),
      "reviewer coverage must hold exactly one entry for tests, and holds 2",
    ],
    [
      "not_applicable without a reason",
      reviewOutput({ coverage: cleanCoverage({ performance: { status: "not_applicable", reason: null } }) }),
      "reviewer coverage of performance is not_applicable and must give a reason",
    ],
    [
      "not_run without a reason",
      reviewOutput({ coverage: cleanCoverage({ security: { status: "not_run", reason: " " } }) }),
      "reviewer coverage of security is not_run and must give a reason",
    ],
    [
      "a conformance kind outside the three",
      reviewOutput({ conformance: [{ kind: "wrong", slice: null, detail: "x" }] }),
      'reviewer conformance 1 has kind "wrong", which is not one of missing, extra, misunderstood',
    ],
  ])("refuses %s", (_name, raw, message) => {
    expect(() => parseReviewReport(raw)).toThrow(message);
  });
});

describe("the review dimensions", () => {
  test("are the rows of the dim-station-review passes table", () => {
    const skill = readFileSync(
      join(import.meta.dir, "..", "skills", "dim-station-review", "SKILL.md"),
      "utf8",
    );
    const passes = skill.split("## The passes")[1]?.split("\n## ")[0] ?? "";
    const rows = passes
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| dimension"))
      .map((line) => line.split("|")[1]?.trim());
    expect(rows).toEqual([...REVIEW_DIMENSIONS]);
  });

  test("are the dimensions the output schema allows", () => {
    const item = (key: "findings" | "coverage") =>
      schema.properties[key].items.properties.dimension.enum as string[];
    expect(item("findings")).toEqual([...REVIEW_DIMENSIONS]);
    expect(item("coverage")).toEqual([...REVIEW_DIMENSIONS]);
  });
});
