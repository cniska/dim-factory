import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchesEqual, rebaseState } from "./git-rebase";

describe("patchesEqual", () => {
  const changed = [
    "1:  1880911 ! 1:  049c477 feat: change d",
    "    @@ Commit message",
    "     ",
    "      ## f.txt ##",
    "     @@",
    "    - a",
    "    + A",
    "      b",
    "      c",
    "     -d",
    "2:  1af8184 = 2:  10fe0c1 feat: add g",
  ].join("\n");

  test("a pair whose patch changed makes the rewrite unequal", () => {
    expect(patchesEqual(changed)).toBe(false);
  });

  test("every pair carrying its patch makes the rewrite equal", () => {
    expect(
      patchesEqual("1:  1880911 = 1:  049c477 feat: change d\n2:  1af8184 = 2:  10fe0c1 feat: add g"),
    ).toBe(true);
  });

  test("a commit dropped or added on one side makes the rewrite unequal", () => {
    expect(patchesEqual("1:  1880911 < -:  ------- feat: change d")).toBe(false);
    expect(patchesEqual("-:  ------- > 1:  049c477 feat: change d")).toBe(false);
  });

  test("output with no pair at all is not read as equal", () => {
    expect(patchesEqual("")).toBe(false);
  });
});

describe("a git command the rebase needs", () => {
  test("fails with its code, the directory and the command it ran", () => {
    const dir = mkdtempSync(join(tmpdir(), "dim-not-a-repo-"));
    try {
      expect(() => rebaseState(dir)).toThrow(
        expect.objectContaining({
          code: "git_failed",
          meta: expect.objectContaining({
            dir,
            args: ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"],
          }),
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
