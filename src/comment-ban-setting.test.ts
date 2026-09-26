import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentsBanned } from "./comment-ban-setting";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function machine(setting: string | null): { DIM_HOME: string } {
  const home = mkdtempSync(join(tmpdir(), "dim-comment-gate-"));
  roots.push(home);
  if (setting !== null) writeFileSync(join(home, "comment-gate.json"), setting);
  return { DIM_HOME: home };
}

describe("where comments are banned", () => {
  test("nowhere when the setting is absent", () => {
    expect(commentsBanned("cniska/dim-factory", machine(null))).toBe(false);
  });

  test("nowhere when the file names no repos", () => {
    expect(commentsBanned("cniska/dim-factory", machine("{}"))).toBe(false);
  });

  test("in each repo the list names, and no other", () => {
    const env = machine('{ "repos": ["cniska/dim-factory"] }');
    expect(commentsBanned("cniska/dim-factory", env)).toBe(true);
    expect(commentsBanned("cniska/other", env)).toBe(false);
  });

  test("however the list spells a repo's case", () => {
    expect(commentsBanned("cniska/dim-factory", machine('{ "repos": ["CNiska/Dim-Factory"] }'))).toBe(true);
  });

  test("in every repo when the setting is all", () => {
    const env = machine('{ "repos": "all" }');
    expect(commentsBanned("cniska/dim-factory", env)).toBe(true);
    expect(commentsBanned("someone/else", env)).toBe(true);
  });

  test("reads a file carrying comments of its own", () => {
    expect(commentsBanned("a/b", machine('{\n  // the repos\n  "repos": ["a/b"],\n}\n'))).toBe(true);
  });

  for (const [what, setting] of [
    ["a single label rather than a list", '{ "repos": "cniska/dim-factory" }'],
    ["a label without an owner", '{ "repos": ["dim-factory"] }'],
    ["a setting nothing reads", '{ "repo": ["cniska/dim-factory"] }'],
    ["a repeated key", '{ "repos": ["a/b"], "repos": "all" }'],
    ["a list that is not an object", '["cniska/dim-factory"]'],
    ["a file that does not parse", '{ "repos": '],
  ]) {
    test(`refuses ${what}, naming the file`, () => {
      const env = machine(setting as string);
      expect(() => commentsBanned("cniska/dim-factory", env)).toThrow(
        join(env.DIM_HOME, "comment-gate.json"),
      );
    });
  }
});
