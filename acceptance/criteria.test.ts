import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CITED = /^((?:AC-\d+ )+)/;

const firstGroups = (text: string, pattern: RegExp): readonly string[] =>
  [...text.matchAll(pattern)].flatMap((match) => match.slice(1, 2));

const spec = readFileSync(join(ROOT, "SPEC.md"), "utf8");
const criteria = firstGroups(spec, /^- \*\*(AC-\d+)\*\*/gm);
const ids = firstGroups(spec, /^- \*\*([^*]+)\*\* —/gm);
const familyOf = (id: string): string => id.split("-")[0] ?? id;
const families = [...new Set(ids.map(familyOf))];
const UNCITED_FAMILIES = ["AC", "C", "D"];
const requirementFamilies = families.filter((family) => !UNCITED_FAMILIES.includes(family));
const requirements = ids.filter((id) => requirementFamilies.includes(familyOf(id)));
const criterionLines = spec.split("\n").filter((line) => /^- \*\*AC-\d+\*\*/.test(line));
const cited = `(?:${requirementFamilies.join("|")})-\\d+`;
const CITATION_LIST = new RegExp(`\\((${cited}(?:, ${cited})*)\\)$`);
const citationsOf = (line: string): readonly string[] => CITATION_LIST.exec(line)?.[1]?.split(", ") ?? [];
const citations = criterionLines.flatMap(citationsOf);
const mentioned = firstGroups(spec, new RegExp(`\\b((?:${families.join("|")})-\\d+)\\b`, "g"));

const names = readdirSync(import.meta.dir)
  .filter((file) => file.endsWith(".acceptance.ts"))
  .flatMap((file) =>
    firstGroups(readFileSync(join(import.meta.dir, file), "utf8"), /\btest(?:\.todo)?\(\s*["`]([^"`]*)/g),
  );

const citedBy = (name: string): readonly string[] => CITED.exec(name)?.[1]?.trim().split(" ") ?? [];

describe("the spec's ids", () => {
  test("every id is a family and a whole number, numbered from 1 in sequence within its family", () => {
    for (const family of families) {
      const members = ids.filter((id) => id.startsWith(`${family}-`));
      expect(members).toEqual(members.map((_, index) => `${family}-${index + 1}`));
    }
  });

  test("every criterion ends with the requirements it cites", () => {
    expect(criterionLines.filter((line) => citationsOf(line).length === 0)).toEqual([]);
  });

  test("every id the spec mentions, in a citation or in prose, is defined in it", () => {
    expect(mentioned.filter((id) => !ids.includes(id))).toEqual([]);
  });

  test("every requirement is cited by a criterion", () => {
    expect(requirements.filter((id) => !citations.includes(id))).toEqual([]);
  });
});

describe("acceptance tests and the spec's criteria", () => {
  test("the spec's criteria and the acceptance tests are both found", () => {
    expect(criteria.length).toBeGreaterThan(0);
    expect(names.length).toBeGreaterThan(0);
  });

  test("every acceptance test's name starts with the criteria it proves", () => {
    expect(names.filter((name) => citedBy(name).length === 0)).toEqual([]);
  });

  test("every criterion an acceptance test cites is in the spec", () => {
    expect(names.flatMap(citedBy).filter((id) => !criteria.includes(id))).toEqual([]);
  });

  test("every criterion in the spec has an acceptance test or a todo", () => {
    const cited = new Set(names.flatMap(citedBy));
    expect(criteria.filter((id) => !cited.has(id))).toEqual([]);
  });
});
