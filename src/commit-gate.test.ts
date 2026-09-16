import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSubject, hookScript, installCommitGate, planCommitGate } from "./commit-gate";

describe("subject rules", () => {
  test("accepts a conforming subject", () => {
    expect(checkSubject("feat: score how far a session has moved")).toBeNull();
    expect(checkSubject("fix(neochess): unify game and lesson UI")).toBeNull();
  });

  test("names the rule each subject breaks", () => {
    expect(checkSubject("")).toBe("empty");
    expect(checkSubject("feat: a thing", "and why it happened")).toBe("body");
    expect(checkSubject("added a thing")).toBe("not-conventional");
    expect(checkSubject("feat: résumé the session")).toBe("not-ascii");
  });

  // 50 exactly is the limit the conforming history sits on, so the boundary is
  // the rule: one character either side has to fall on opposite sides of it.
  test("holds the length limit at exactly fifty", () => {
    const at50 = `feat: ${"a".repeat(44)}`;
    expect(at50).toHaveLength(50);
    expect(checkSubject(at50)).toBeNull();
    expect(checkSubject(`${at50}a`)).toBe("too-long");
  });
});

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "dim-gate-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  return dir;
}

function commit(dir: string, subject: string): { ok: boolean; err: string } {
  writeFileSync(join(dir, `f${Math.random()}`), "x");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  try {
    execFileSync("git", ["-C", dir, "commit", "-m", subject], { stdio: "pipe" });
    return { ok: true, err: "" };
  } catch (e) {
    const err = e as { stderr?: Buffer };
    return { ok: false, err: err.stderr?.toString() ?? "" };
  }
}

describe("the installed hook", () => {
  test("refuses what the rules refuse and passes what they allow", () => {
    const dir = gitRepo();
    try {
      installCommitGate([dir]);
      expect(commit(dir, "feat: a conforming subject").ok).toBe(true);

      const long = commit(dir, `feat: ${"a".repeat(60)}`);
      expect(long.ok).toBe(false);
      expect(long.err).toContain("over the 50 allowed");

      const shape = commit(dir, "just did some stuff");
      expect(shape.ok).toBe(false);
      expect(shape.err).toContain("Conventional Commit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves a repo that already gates its own subjects alone", () => {
    const dir = gitRepo();
    try {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(join(dir, "scripts", "check-commit-message.sh"), "#!/usr/bin/env bash\nexit 0\n");
      expect(planCommitGate([dir])[0]?.state).toBe("has-own-gate");
      installCommitGate([dir]);
      expect(commit(dir, "this would fail the dim gate").ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps a hook already at that name rather than dropping it", () => {
    const dir = gitRepo();
    const path = join(dir, ".git", "hooks", "commit-msg");
    try {
      writeFileSync(path, "#!/usr/bin/env bash\n# the owner's own\nexit 0\n");
      chmodSync(path, 0o755);
      expect(planCommitGate([dir])[0]?.state).toBe("occupied");
      installCommitGate([dir]);
      expect(Bun.file(`${path}.dim-backup`).size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports an already-installed gate as installed", () => {
    const dir = gitRepo();
    try {
      installCommitGate([dir]);
      expect(planCommitGate([dir])[0]?.state).toBe("installed");
      expect(hookScript()).toContain("commit-msg:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
