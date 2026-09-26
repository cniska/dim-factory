import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nestedRepository } from "./station-build-tree";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
}

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), "dim-nested-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "kept.txt"), "kept\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "init"]);
  return dir;
}

describe("finding a repository nested in a worktree", () => {
  test("finds none in a plain tree", () => {
    const dir = tree();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "a\n");

    expect(nestedRepository(dir)).toBeNull();
  });

  test("finds one git would stage whatever case its .git is spelled in", () => {
    const dir = tree();
    mkdirSync(join(dir, "up", ".GIT"), { recursive: true });

    expect(nestedRepository(dir)).toBe("up/.GIT");
  });

  test("finds one under a directory name git would quote", () => {
    const dir = tree();
    const nested = join(dir, "dé", "sub");
    mkdirSync(nested, { recursive: true });
    git(nested, ["init", "-q"]);

    expect(nestedRepository(dir)).toBe("dé/sub/.git");
  });

  test("leaves one in an ignored directory, which git never stages", () => {
    const dir = tree();
    writeFileSync(join(dir, ".gitignore"), "vendor/\n");
    const nested = join(dir, "vendor", "lib");
    mkdirSync(nested, { recursive: true });
    git(nested, ["init", "-q"]);

    expect(nestedRepository(dir)).toBeNull();
  });
});
