import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHook, pathWithDim } from "./gate.test-support";
import { checkSubject } from "./gate-subject";

const WITH_DIM = { ...process.env, PATH: pathWithDim() };

describe("subject rules", () => {
  test("accepts a conforming subject", () => {
    expect(checkSubject("feat: score how far a session has moved", "")).toBeNull();
    expect(checkSubject("fix(parser): fold the two entry points into one", "")).toBeNull();
  });

  test("names the rule each subject breaks", () => {
    expect(checkSubject("", "")).toBe("empty");
    expect(checkSubject("feat: a thing", "and why it happened")).toBe("body");
    expect(checkSubject("added a thing", "")).toBe("not-conventional");
    expect(checkSubject("revert: the wall feed time", "")).toBe("not-conventional");
    expect(checkSubject("feat: résumé the session", "")).toBe("not-ascii");
  });

  test("holds the length limit at exactly fifty", () => {
    const at50 = `feat: ${"a".repeat(44)}`;
    expect(at50).toHaveLength(50);
    expect(checkSubject(at50, "")).toBeNull();
    expect(checkSubject(`${at50}a`, "")).toBe("too-long");
  });
});

function repoWithHook(origin: string | null, owners = ["github.com/cniska", "other-org"]): string {
  const dir = mkdtempSync(join(tmpdir(), "dim-gate-"));
  const hooks = join(dir, "hooks");
  installHook(hooks, "commit-msg", owners);

  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "config", "core.hooksPath", hooks]);
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return dir;
}

function commit(dir: string, subject: string): { ok: boolean; err: string } {
  writeFileSync(join(dir, `f${Math.random()}`), "x");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  const run = spawnSync("git", ["-C", dir, "commit", "-m", subject], { encoding: "utf8", env: WITH_DIM });
  return { ok: run.status === 0, err: run.stderr };
}

function inRepo(origin: string | null, owners?: string[]): (check: (dir: string) => void) => void {
  return (check) => {
    const dir = repoWithHook(origin, owners);
    try {
      check(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const OWNED = "git@github.com:cniska/thing.git";

describe("the commit-msg hook", () => {
  test("enforces the rules in a repo whose owner is named", () =>
    inRepo(OWNED)((dir) => {
      expect(commit(dir, "feat: a conforming subject").ok).toBe(true);
      const long = commit(dir, `feat: ${"a".repeat(60)}`);
      expect(long.ok).toBe(false);
      expect(long.err).toContain("over the 50 allowed");
      const shape = commit(dir, "just did some stuff");
      expect(shape.ok).toBe(false);
      expect(shape.err).toContain("Conventional Commit");
    }));

  test("enforces them however the remote spells the owner", () =>
    inRepo("git@GitHub.com:CNiska/thing.git")((dir) => {
      expect(commit(dir, "just did some stuff").err).toContain("Conventional Commit");
    }));

  test("enforces them however the owner list spells the owner", () =>
    inRepo(OWNED, ["GitHub.com/CNiska"])((dir) => {
      expect(commit(dir, "just did some stuff").err).toContain("Conventional Commit");
    }));

  test("passes through a repo owned by someone else", () =>
    inRepo("https://github.com/mastra-ai/mastra.git")((dir) => {
      expect(commit(dir, "this would fail every rule the gate has").ok).toBe(true);
    }));

  test("passes through a repo with no remote at all", () =>
    inRepo(null)((dir) => {
      expect(commit(dir, "no remote means no owner to match").ok).toBe(true);
    }));

  test("passes a merge commit through unjudged", () =>
    inRepo(OWNED)((dir) => {
      expect(commit(dir, "feat: start the repo").ok).toBe(true);
      const base = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", dir, "checkout", "-qb", "side"]);
      expect(commit(dir, "feat: add side file").ok).toBe(true);
      execFileSync("git", ["-C", dir, "checkout", "-q", base]);
      execFileSync("git", ["-C", dir, "merge", "--no-ff", "--no-commit", "side"], { stdio: "pipe" });

      expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
      expect(commit(dir, "Merge branch 'side'").ok).toBe(true);
    }));

  test("lets a fixup of a conforming subject through, even past fifty characters", () =>
    inRepo(OWNED)((dir) => {
      expect(commit(dir, `fixup! feat: ${"a".repeat(44)}`).ok).toBe(true);
      expect(commit(dir, "fixup! fixup! feat: a conforming subject").ok).toBe(true);
    }));

  test("judges the subject a fixup names by the same rules", () =>
    inRepo(OWNED)((dir) => {
      expect(commit(dir, "fixup! just did some stuff").err).toContain("Conventional Commit");
      expect(commit(dir, "squash! feat: a conforming subject").ok).toBe(false);
      expect(commit(dir, "fixup!feat: a conforming subject").ok).toBe(false);
    }));

  test("lets a bad subject through where dim is missing, and says it was not judged", () =>
    inRepo(OWNED)((dir) => {
      writeFileSync(join(dir, "f"), "x");
      execFileSync("git", ["-C", dir, "add", "-A"]);
      const run = spawnSync("git", ["-C", dir, "commit", "-q", "-m", "just did some stuff"], {
        env: { ...process.env, PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      expect(run.stderr).toContain("commit-msg: dim is not on PATH, so this is not judged.");
    }));

  test("treats shell syntax in an owner as data", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "dim-hook-owner-")), "ran");
    inRepo("git@github.com:x/thing.git", [`github.com/x$(touch ${marker})\ntouch ${marker}`])((dir) => {
      expect(commit(dir, "not conventional, but not this owner's repo either").ok).toBe(true);
      expect(existsSync(marker)).toBe(false);
    });
  });
});
