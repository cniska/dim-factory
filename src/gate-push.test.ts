import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { prePushScript, URL_NORMALIZER, unarmedCheckouts } from "./gate-push";

type Repo = { root: string; work: string };

const ISOLATED = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
} as NodeJS.ProcessEnv;

function bareGit(...args: string[]): void {
  execFileSync("git", args, { env: ISOLATED, stdio: "pipe" });
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe", env: ISOLATED });
}

function clonedRepo(owner: string): Repo {
  const root = mkdtempSync(join(tmpdir(), "dim-push-"));
  const bare = join(root, owner, "thing.git");
  mkdirSync(join(root, owner), { recursive: true });
  bareGit("init", "-q", "--bare", "-b", "main", bare);

  const work = join(root, "work");
  bareGit("clone", "-q", bare, work);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "T");
  commit(work, "first");
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "remote", "set-head", "origin", "-a");

  const hooks = join(root, "hooks");
  mkdirSync(hooks, { recursive: true });
  const path = join(hooks, "pre-push");
  writeFileSync(path, prePushScript([join(root, "gated-owner"), "other-org"]));
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
    const { root, work } = clonedRepo("gated-owner");
    try {
      commit(work, "second");
      expect(push(work, "origin", "main").ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a push that drops the remote tip out of the history", () => {
    const { root, work } = clonedRepo("gated-owner");
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

  test("refuses a push carrying a revert", () => {
    const { root, work } = clonedRepo("gated-owner");
    try {
      commit(work, "second");
      git(work, "revert", "--no-edit", "HEAD");

      const pushed = push(work, "origin", "main");
      expect(pushed.ok).toBe(false);
      expect(pushed.err).toContain("pushes a revert");
      expect(pushed.err).toContain("reset or rebase it out");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a revert pushed on a branch of its own", () => {
    const { root, work } = clonedRepo("gated-owner");
    try {
      git(work, "checkout", "-qb", "side");
      commit(work, "second");
      git(work, "revert", "--no-edit", "HEAD");

      expect(push(work, "origin", "side").err).toContain("pushes a revert");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a delete of the default branch", () => {
    const { root, work } = clonedRepo("gated-owner");
    try {
      const deleted = push(work, "origin", "--delete", "main");
      expect(deleted.ok).toBe(false);
      expect(deleted.err).toContain("deletes refs/heads/main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [label, spell] of [
    ["its path", (root: string) => join(root, "gated-owner", "thing.git")],
    ["a trailing slash", (root: string) => `${join(root, "gated-owner", "thing.git")}/`],
    ["a dot segment", (root: string) => `${join(root, "gated-owner")}/./thing.git`],
    ["a file URL", (root: string) => `file://${join(root, "gated-owner", "thing.git")}`],
  ] as [string, (root: string) => string][]) {
    test(`refuses a rewrite pushed to the remote by ${label}`, () => {
      const { root, work } = clonedRepo("gated-owner");
      try {
        commit(work, "second");
        git(work, "push", "-q", "origin", "main");
        git(work, "reset", "--hard", "-q", "HEAD~1");
        commit(work, "rewritten");

        const forced = push(work, "--force", spell(root), "main");
        expect(forced.ok).toBe(false);
        expect(forced.err).toContain("rewrites refs/heads/main");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("passes a push to a URL no configured remote carries", () => {
    const { root, work } = clonedRepo("gated-owner");
    const elsewhere = join(root, "elsewhere.git");
    try {
      bareGit("init", "-q", "--bare", "-b", "main", elsewhere);
      expect(push(work, elsewhere, "main").ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves a branch that is not the remote's HEAD alone", () => {
    const { root, work } = clonedRepo("gated-owner");
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

  test("passes through a repo owned by someone else", () => {
    const { root, work } = clonedRepo("someone-else");
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

  test("refuses a push over a remote tip this checkout has never fetched", () => {
    const { root, work } = clonedRepo("gated-owner");
    const other = join(root, "other");
    try {
      bareGit("clone", "-q", join(root, "gated-owner", "thing.git"), other);
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

  test("names the checkouts whose remote has no HEAD, and leaves the armed ones out", () => {
    const { root, work } = clonedRepo("gated-owner");
    const started = join(root, "started");
    try {
      const ownBare = join(root, "cniska", "started.git");
      bareGit("init", "-q", "--bare", "-b", "main", ownBare);
      bareGit("init", "-q", "-b", "main", started);
      git(started, "config", "user.email", "t@example.com");
      git(started, "config", "user.name", "T");
      git(started, "remote", "add", "origin", ownBare);
      commit(started, "first");
      git(started, "push", "-q", "-u", "origin", "main");

      const local = join(root, "local");
      bareGit("init", "-q", "-b", "main", local);

      expect(unarmedCheckouts([work, started, local])).toEqual([started]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lets everything through where the remote names no HEAD", () => {
    const { root, work } = clonedRepo("gated-owner");
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

describe("dim_url", () => {
  function norm(url: string): string {
    return execFileSync("bash", ["-c", `${URL_NORMALIZER}\ndim_url "$1"`, "_", url], {
      encoding: "utf8",
    });
  }

  test("drops a trailing slash from a remote URL", () => {
    expect(norm("https://github.com/an-owner/thing.git/")).toBe("https://github.com/an-owner/thing.git");
  });

  test("drops a file scheme from a local path", () => {
    expect(norm("file:///nowhere/thing.git")).toBe("/nowhere/thing.git");
  });

  test("leaves a remote URL otherwise untouched", () => {
    expect(norm("https://github.com/an-owner/thing.git")).toBe("https://github.com/an-owner/thing.git");
  });
});
