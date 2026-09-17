import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prePushScript } from "./push-gate";

type Repo = { root: string; work: string };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" });
}

/**
 * The owner the hook matches is read off the remote URL, so the bare repo sits
 * under a directory named for one: a file path ends in `<owner>/<repo>.git` the
 * same way an ssh remote does.
 */
function clonedRepo(owner: string): Repo {
  const root = mkdtempSync(join(tmpdir(), "dim-push-"));
  const bare = join(root, owner, "thing.git");
  mkdirSync(join(root, owner), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);

  const work = join(root, "work");
  execFileSync("git", ["clone", "-q", bare, work]);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "T");
  commit(work, "first");
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "remote", "set-head", "origin", "-a");

  const hooks = join(root, "hooks");
  mkdirSync(hooks, { recursive: true });
  const path = join(hooks, "pre-push");
  writeFileSync(path, prePushScript(["cniska", "other-org"]));
  execFileSync("chmod", ["755", path]);
  git(work, "config", "core.hooksPath", hooks);
  return { root, work };
}

function commit(dir: string, text: string): void {
  writeFileSync(join(dir, `f${Math.random()}`), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `feat: ${text}`);
}

function push(dir: string, ...args: string[]): { ok: boolean; err: string } {
  try {
    git(dir, "push", "-q", ...args);
    return { ok: true, err: "" };
  } catch (e) {
    return { ok: false, err: (e as { stderr?: Buffer }).stderr?.toString() ?? "" };
  }
}

describe("the push gate", () => {
  test("lets a fast-forward onto the default branch through", () => {
    const { root, work } = clonedRepo("cniska");
    try {
      commit(work, "second");
      expect(push(work, "origin", "main").ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a push that drops the remote tip out of the history", () => {
    const { root, work } = clonedRepo("cniska");
    try {
      commit(work, "second");
      git(work, "push", "-q", "origin", "main");
      git(work, "reset", "--hard", "-q", "HEAD~1");
      commit(work, "rewritten");

      const forced = push(work, "--force", "origin", "main");
      expect(forced.ok).toBe(false);
      expect(forced.err).toContain("rewrites refs/heads/main");
      expect(forced.err).toContain("--no-verify");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a delete of the default branch", () => {
    const { root, work } = clonedRepo("cniska");
    try {
      const deleted = push(work, "origin", "--delete", "main");
      expect(deleted.ok).toBe(false);
      expect(deleted.err).toContain("deletes refs/heads/main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A topic branch is rewritten on purpose, and gating that would refuse the
  // rebase-then-force the branch workflow is built on.
  test("leaves a branch that is not the remote's HEAD alone", () => {
    const { root, work } = clonedRepo("cniska");
    try {
      git(work, "checkout", "-q", "-b", "side");
      commit(work, "on a branch");
      git(work, "push", "-q", "origin", "side");
      git(work, "reset", "--hard", "-q", "HEAD~1");
      commit(work, "rewritten on a branch");

      expect(push(work, "--force", "origin", "side").ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The hook meets every clone on the machine, so someone else's project keeps
  // whatever workflow it has.
  test("passes through a repo owned by someone else", () => {
    const { root, work } = clonedRepo("mastra-ai");
    try {
      commit(work, "second");
      git(work, "push", "-q", "origin", "main");
      git(work, "reset", "--hard", "-q", "HEAD~1");
      commit(work, "rewritten");

      expect(push(work, "--force", "origin", "main").ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The remote tip is missing locally exactly when it is a commit this checkout
  // has never seen, which is the push that loses someone else's work rather than
  // the one that cannot be judged.
  test("refuses a push over a remote tip this checkout has never fetched", () => {
    const { root, work } = clonedRepo("cniska");
    const other = join(root, "other");
    try {
      execFileSync("git", ["clone", "-q", join(root, "cniska", "thing.git"), other]);
      git(other, "config", "user.email", "t@example.com");
      git(other, "config", "user.name", "T");
      commit(other, "from the other checkout");
      git(other, "push", "-q", "origin", "main");

      commit(work, "made without fetching");
      const forced = push(work, "--force", "origin", "main");
      expect(forced.ok).toBe(false);
      expect(forced.err).toContain("is not in this checkout");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A remote assembled with `git remote add` never gets a HEAD, and the gate has
  // no way to know which branch is shared without one.
  test("lets everything through where the remote names no HEAD", () => {
    const { root, work } = clonedRepo("cniska");
    try {
      git(work, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
      commit(work, "second");
      git(work, "push", "-q", "origin", "main");
      git(work, "reset", "--hard", "-q", "HEAD~1");
      commit(work, "rewritten");

      expect(push(work, "--force", "origin", "main").ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
