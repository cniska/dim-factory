import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { git, isAncestor, nulFields, ran } from "./git";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function emptyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-git-"));
  roots.push(root);
  Bun.spawnSync(["git", "init", "-q", root]);
  return root;
}

describe("running git", () => {
  test("hands back the exit status, so a no from git is not read as a failure", () => {
    const repo = emptyRepo();
    expect(git(repo, ["rev-parse", "--verify", "-q", "HEAD"]).status).toBe(1);
  });

  test("refuses a command git could not run, naming it and its exit", () => {
    const repo = emptyRepo();
    expect(() => ran(repo, ["rev-parse", "--verify", "-q", "HEAD"])).toThrow(
      expect.objectContaining({
        code: "git_failed",
        kind: "refusal",
        meta: { repo, command: "git rev-parse --verify -q HEAD", status: 1, detail: "" },
      }),
    );
  });

  test("refuses an ancestry question about a commit that does not exist, rather than answering no", () => {
    const repo = emptyRepo();
    expect(() => isAncestor(repo, "0000000000000000000000000000000000000000", "HEAD")).toThrow(
      expect.objectContaining({ code: "git_failed" }),
    );
  });

  test("refuses NUL-separated output whose last record is cut off", () => {
    expect(nulFields("a\0b\0", "git ls-files -z")).toEqual(["a", "b"]);
    expect(() => nulFields("a\0b", "git ls-files -z")).toThrow(
      expect.objectContaining({ code: "git_output_malformed" }),
    );
  });
});

describe("the product", () => {
  test("spawns git in one place", () => {
    const spawning = [...new Glob("**/*.{ts,tsx}").scanSync(import.meta.dir)]
      .filter((file) => !/\.test\.tsx?$|test-support/.test(file) && file !== "git.ts")
      .filter((file) =>
        /(spawnSync|spawn|execFileSync|execFile)\(\s*\[?\s*"git"/.test(
          readFileSync(join(import.meta.dir, file), "utf8"),
        ),
      );
    expect(spawning).toEqual([]);
  });
});
