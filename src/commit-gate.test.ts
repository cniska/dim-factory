import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSubject,
  hookScript,
  installCommitGate,
  preCommitScript,
  SKIP_CHECK_ENV,
  sharedHooksDir,
} from "./commit-gate";

describe("subject rules", () => {
  test("accepts a conforming subject", () => {
    expect(checkSubject("feat: score how far a session has moved")).toBeNull();
    expect(checkSubject("fix(parser): fold the two entry points into one")).toBeNull();
  });

  test("names the rule each subject breaks", () => {
    expect(checkSubject("")).toBe("empty");
    expect(checkSubject("feat: a thing", "and why it happened")).toBe("body");
    expect(checkSubject("added a thing")).toBe("not-conventional");
    // Nothing here is ever reverted, so there is no type to write one under.
    expect(checkSubject("revert: the wall feed time")).toBe("not-conventional");
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

function repoWithHook(
  origin: string | null,
  owners = ["github.com/cniska", "other-org"],
): { dir: string; hooks: string } {
  const dir = mkdtempSync(join(tmpdir(), "dim-gate-"));
  const hooks = join(dir, "hooks");
  mkdirSync(hooks, { recursive: true });
  const path = join(hooks, "commit-msg");
  writeFileSync(path, hookScript(owners));
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

  // A forge answers to either spelling of the same clone, and the owner list
  // holds one of them, so case is the difference that must not decide whether
  // anything is gated at all.
  test("enforces them however the remote spells the owner", () => {
    const { dir } = repoWithHook("git@GitHub.com:CNiska/thing.git");
    try {
      const shape = commit(dir, "just did some stuff");
      expect(shape.ok).toBe(false);
      expect(shape.err).toContain("Conventional Commit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enforces them however the owner list spells the owner", () => {
    const { dir } = repoWithHook("git@github.com:cniska/thing.git", ["GitHub.com/CNiska"]);
    try {
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

  // Git generates a merge subject; there is no author to hold it to the
  // Conventional Commit shape, so MERGE_HEAD being present is what exempts it.
  test("passes a merge commit through unjudged", () => {
    const { dir } = repoWithHook("git@github.com:cniska/thing.git");
    try {
      expect(commit(dir, "feat: start the repo").ok).toBe(true);
      const base = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", dir, "checkout", "-qb", "side"]);
      writeFileSync(join(dir, "side"), "x");
      execFileSync("git", ["-C", dir, "add", "-A"]);
      execFileSync("git", ["-C", dir, "commit", "-m", "feat: add side file"]);
      execFileSync("git", ["-C", dir, "checkout", "-q", base]);
      execFileSync("git", ["-C", dir, "merge", "--no-ff", "--no-commit", "side"], { stdio: "pipe" });

      expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
      const merged = commit(dir, "Merge branch 'side'");
      expect(merged.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The exemption is MERGE_HEAD alone; an ordinary commit still holds to the
  // rule, so it cannot widen into "anything goes".
  test("still refuses an ordinary bad subject outside a merge", () => {
    const { dir } = repoWithHook("git@github.com:cniska/thing.git");
    try {
      const shape = commit(dir, "just did some stuff");
      expect(shape.ok).toBe(false);
      expect(shape.err).toContain("Conventional Commit");
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

  // What the gate is made of is the part a reader cannot see from any one hook's
  // own tests: each is written and tested in its own file, and nothing else says
  // the installer actually puts all of them on disk.
  test("writes every hook the gate owns, and reports each one", () => {
    const home = mkdtempSync(join(tmpdir(), "dim-home-"));
    try {
      const env = { HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig") };
      const plan = installCommitGate(["cniska"], [], env);
      expect(plan.hooks.map((h) => h.name)).toEqual(["commit-msg", "pre-commit", "pre-push"]);
      for (const hook of plan.hooks) {
        expect(hook.state).toBe("installed");
        expect(existsSync(join(sharedHooksDir(env), hook.name))).toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the owner list is the only thing that changes between installs", () => {
    expect(hookScript(["cniska"])).not.toEqual(hookScript(["cniska", "other-org"]));
    expect(hookScript(["cniska", "other-org"])).toContain(" cniska other-org ");
  });
});

describe("the check gate", () => {
  // `--no-verify` is git's only escape and it takes the subject gate with it,
  // so a slow check without this would make the working gate the casualty.
  test("skips itself on the env escape, before anything else", () => {
    const script = preCommitScript(["cniska"]);
    const skip = script.indexOf(SKIP_CHECK_ENV);
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(script.indexOf("remote.origin.url"));
  });

  test("runs nothing for a repo that is not the owner's", () => {
    const script = preCommitScript(["cniska"]);
    expect(script).toContain('case " cniska " in');
    expect(script.indexOf('case " cniska " in')).toBeLessThan(script.indexOf("dim check-command"));
  });

  // It runs before every commit on the machine, so anything it cannot establish
  // has to let the commit through.
  test("exits 0 where dim or the declared check is missing", () => {
    const script = preCommitScript(["cniska"]);
    expect(script).toContain("command -v dim >/dev/null 2>&1 || exit 0");
    expect(script).toContain('[ -n "$check" ] || exit 0');
  });

  // Git exports these to a hook, so a check that runs git itself would inherit
  // the committing repo's index; the worktree suite failed exactly this way.
  test("clears git's own environment before running the check", () => {
    const script = preCommitScript(["cniska"]);
    for (const v of [
      "GIT_DIR",
      "GIT_INDEX_FILE",
      "GIT_WORK_TREE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_DATE",
    ]) {
      expect(script).toContain(v);
    }
    expect(script.indexOf("unset GIT_DIR")).toBeLessThan(script.indexOf('eval "$check"'));
  });

  test("refuses the commit when the check fails, and names the way past it", () => {
    const script = preCommitScript(["cniska"]);
    expect(script).toContain("exit 1");
    expect(script).toContain(`${SKIP_CHECK_ENV}=1 git commit`);
  });
});

/**
 * The pre-commit gate runs `eval "$check"` over whatever the repo's own manifest
 * declares, so arming it in a repo the owner does not own is arbitrary code
 * execution on the first commit in a clone. A `dim` shim stands in for
 * `check-command` so the arming is what is under test and not the lookup.
 */
function repoRunningItsOwnCheck(origin: string, owners: string[]): { dir: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "dim-arm-"));
  const hooks = join(dir, "hooks");
  const bin = join(dir, "bin");
  mkdirSync(hooks, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const marker = join(dir, "marker");
  const shim = join(bin, "dim");
  writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s' "printf pwned > ${marker}"\n`);
  execFileSync("chmod", ["755", shim]);

  const hook = join(hooks, "pre-commit");
  writeFileSync(hook, preCommitScript(owners));
  execFileSync("chmod", ["755", hook]);

  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "config", "core.hooksPath", hooks]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);

  writeFileSync(join(dir, "a"), "x");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-m", "feat: a conforming subject"], {
    stdio: "pipe",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { dir, marker };
}

describe("arming the check the gate runs", () => {
  // Proves the arming works at all, so the refusals below mean something.
  test("runs the declared check in a repo the owner owns", () => {
    const { dir, marker } = repoRunningItsOwnCheck("git@github.com:cniska/thing.git", ["github.com/cniska"]);
    try {
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An account name is not an identity: anyone may register `cniska` on another
  // forge, or name a directory that way, and the gate reads the whole URL.
  for (const origin of [
    "https://gitlab.com/cniska/evil.git",
    "git@evil.example.com:cniska/evil.git",
    "https://github.com/org/cniska/evil.git",
  ]) {
    test(`runs nothing for a repo at ${origin}`, () => {
      const { dir, marker } = repoRunningItsOwnCheck(origin, ["github.com/cniska"]);
      try {
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
