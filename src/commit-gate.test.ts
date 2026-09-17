import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSubject, hookScript, installCommitGate, sharedHooksDir } from "./commit-gate";

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

function repoWithHook(origin: string | null): { dir: string; hooks: string } {
  const dir = mkdtempSync(join(tmpdir(), "dim-gate-"));
  const hooks = join(dir, "hooks");
  mkdirSync(hooks, { recursive: true });
  const path = join(hooks, "commit-msg");
  writeFileSync(path, hookScript(["cniska", "other-org"]));
  execFileSync("chmod", ["755", path]);

  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "config", "core.hooksPath", hooks]);
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return { dir, hooks };
}

function commit(dir: string, subject: string): { ok: boolean; err: string } {
  writeFileSync(join(dir, `f${Math.random()}`), "x");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  try {
    execFileSync("git", ["-C", dir, "commit", "-m", subject], { stdio: "pipe" });
    return { ok: true, err: "" };
  } catch (e) {
    return { ok: false, err: (e as { stderr?: Buffer }).stderr?.toString() ?? "" };
  }
}

describe("the shared hook", () => {
  test("enforces the rules in a repo whose owner is named", () => {
    const { dir } = repoWithHook("git@github.com:cniska/thing.git");
    try {
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

  // The hook is installed globally, so it meets every clone on the machine.
  // Someone else's project keeps its own conventions or this refuses work that
  // is correct there.
  test("passes through a repo owned by someone else", () => {
    const { dir } = repoWithHook("https://github.com/mastra-ai/mastra.git");
    try {
      expect(commit(dir, "this would fail every rule the gate has").ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("passes through a repo with no remote at all", () => {
    const { dir } = repoWithHook(null);
    try {
      expect(commit(dir, "no remote means no owner to match").ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("puts the one hook under the reader's own config directory", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-home-"));
    try {
      expect(sharedHooksDir({ HOME: home })).toBe(join(home, ".config", "dim", "hooks"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Git reads one hooks directory and merges nothing, so installing over a path
  // someone else set disables it. The refusal has to come before the per-repo
  // copies are cleared, or a refused install leaves the machine gated by nothing.
  test("refuses a global hooks path it does not own, without touching anything", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-home-"));
    const theirs = mkdtempSync(join(tmpdir(), "dim-theirs-"));
    const checkout = mkdtempSync(join(tmpdir(), "dim-repo-"));
    try {
      const perRepo = join(checkout, ".git", "hooks", "commit-msg");
      mkdirSync(join(checkout, ".git", "hooks"), { recursive: true });
      writeFileSync(perRepo, "#!/bin/sh\nexit 0\n");

      const env = { HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig") };
      execFileSync("git", ["config", "--global", "core.hooksPath", theirs], {
        env: { ...process.env, ...env },
      });

      let thrown: unknown;
      try {
        installCommitGate(["cniska"], [checkout], env);
      } catch (e) {
        thrown = e;
      }
      expect((thrown as { code?: string })?.code).toBe("HOOKS_PATH_TAKEN");
      expect((thrown as Error).message).toContain(theirs);

      // Nothing written, nothing deleted, and their setting still stands.
      expect(existsSync(join(sharedHooksDir(env), "commit-msg"))).toBe(false);
      expect(existsSync(perRepo)).toBe(true);
      expect(
        execFileSync("git", ["config", "--global", "--get", "core.hooksPath"], {
          env: { ...process.env, ...env },
          encoding: "utf8",
        }).trim(),
      ).toBe(theirs);
    } finally {
      for (const d of [home, theirs, checkout]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("the owner list is the only thing that changes between installs", () => {
    expect(hookScript(["cniska"])).not.toEqual(hookScript(["cniska", "other-org"]));
    expect(hookScript(["cniska", "other-org"])).toContain(" cniska other-org ");
  });
});
