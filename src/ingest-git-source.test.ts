import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invariant } from "./assert";
import { commitKind, readCommits, repoRoot } from "./ingest-git-source";

function git(args: string[], cwd: string): void {
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
}

function repoWith(subjects: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "dim-git-"));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  subjects.forEach((subject, i) => {
    writeFileSync(join(dir, `f${i}.txt`), String(i));
    git(["add", "."], dir);
    git(["commit", "-q", "-m", subject], dir);
  });
  return dir;
}

describe("commit kind", () => {
  test("reads the conventional-commits type, scope and breaking marker alike", () => {
    expect(commitKind("fix: stop the double count")).toBe("fix");
    expect(commitKind("feat(query): add a window")).toBe("feat");
    expect(commitKind("fix(api)!: change the shape")).toBe("fix");
  });

  test("is null when there is no type to read, rather than guessing one", () => {
    expect(commitKind("stop the double count")).toBeNull();
    expect(commitKind("WIP")).toBeNull();
    expect(commitKind("something: else")).toBe("something");
  });
});

describe("reading a repo", () => {
  test("reads each commit with the files it touched", () => {
    const dir = repoWith(["feat: one", "fix: two"]);
    try {
      const root = repoRoot(dir);
      invariant(root !== null, "the fixture is a repo");
      const commits = readCommits(root, null);
      expect(commits.length).toBe(2);
      const fix = commits.find((c) => c.subject === "fix: two");
      expect(fix?.kind).toBe("fix");
      expect(fix?.files).toEqual(["f1.txt"]);
      expect(fix?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory that is gone or was never a repo has no root", () => {
    expect(repoRoot("/no/such/directory/anywhere")).toBeNull();
    const plain = mkdtempSync(join(tmpdir(), "dim-plain-"));
    try {
      expect(repoRoot(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("a repo with no commits yet has none to read, and a checkout git cannot read is refused", () => {
    const empty = mkdtempSync(join(tmpdir(), "dim-empty-"));
    const broken = mkdtempSync(join(tmpdir(), "dim-broken-"));
    try {
      git(["init", "-q", empty], empty);
      expect(readCommits(empty, null)).toEqual([]);
      writeFileSync(join(broken, ".git"), "gitdir: /nonexistent/dim-test\n");
      expect(() => repoRoot(broken)).toThrow(expect.objectContaining({ code: "git_failed" }));
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
