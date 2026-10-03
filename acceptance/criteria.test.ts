import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CITED = /^((?:AC-\d+ )+)/;

const firstGroups = (text: string, pattern: RegExp): readonly string[] =>
  [...text.matchAll(pattern)].flatMap((match) => match.slice(1, 2));

const criteria = firstGroups(readFileSync(join(ROOT, "SPEC.md"), "utf8"), /^- \*\*(AC-\d+)\*\*/gm);

const names = readdirSync(import.meta.dir)
  .filter((file) => file.endsWith(".acceptance.ts"))
  .flatMap((file) =>
    firstGroups(readFileSync(join(import.meta.dir, file), "utf8"), /\btest(?:\.todo)?\(\s*["`]([^"`]*)/g),
  );

const citedBy = (name: string): readonly string[] => CITED.exec(name)?.[1]?.trim().split(" ") ?? [];

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
