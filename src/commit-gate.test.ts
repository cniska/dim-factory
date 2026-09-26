import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSubject,
  commentGateFor,
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
    expect(checkSubject("revert: the wall feed time")).toBe("not-conventional");
    expect(checkSubject("feat: résumé the session")).toBe("not-ascii");
  });

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

  test("exits 0 where dim or the declared check is missing", () => {
    const script = preCommitScript(["cniska"]);
    expect(script).toContain("command -v dim >/dev/null 2>&1 || exit 0");
    expect(script).toContain('[ -n "$check" ] || exit 0');
  });

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

describe("the comment step", () => {
  test("runs after the ownership check and before git's environment is cleared", () => {
    const script = preCommitScript(["cniska"]);
    const step = script.indexOf("dim comments check");
    expect(step).toBeGreaterThan(script.indexOf('case " cniska " in'));
    expect(step).toBeGreaterThan(script.indexOf("command -v dim >/dev/null 2>&1 || exit 0"));
    expect(step).toBeLessThan(script.indexOf("unset GIT_DIR"));
    expect(step).toBeLessThan(script.indexOf("dim check-command"));
  });

  test("refuses only on the exit code that means comments were found", () => {
    const script = preCommitScript(["cniska"]);
    expect(script).toContain('if [ "$status" -eq 3 ]; then');
  });
});

const BANNED = '{ "comments": "banned" }';

function repoWithCommentGate(
  layers: { project?: string; user?: string },
  dimShim = `exec "${process.execPath}" "${join(import.meta.dir, "cli.ts")}" "$@"`,
): {
  dir: string;
  work: string;
  env: Record<string, string>;
  commit: (files: Record<string, string>, env?: Record<string, string>) => { ok: boolean; err: string };
} {
  const dir = mkdtempSync(join(tmpdir(), "dim-comment-hook-"));
  const hooks = join(dir, "hooks");
  const bin = join(dir, "bin");
  const machine = join(dir, "machine");
  const home = join(dir, "home");
  const work = join(dir, "work");
  for (const d of [hooks, bin, machine, join(home, ".config", "dim"), join(work, ".dim")]) {
    mkdirSync(d, { recursive: true });
  }

  const shim = join(bin, "dim");
  writeFileSync(shim, `#!/usr/bin/env bash\n${dimShim}\n`);
  execFileSync("chmod", ["755", shim]);
  const hook = join(hooks, "pre-commit");
  writeFileSync(hook, preCommitScript(["github.com/cniska"]));
  execFileSync("chmod", ["755", hook]);
  if (layers.user !== undefined) writeFileSync(join(home, ".config", "dim", "config.json"), layers.user);

  execFileSync("git", ["init", "-q", work]);
  execFileSync("git", ["-C", work, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", work, "config", "user.name", "T"]);
  execFileSync("git", ["-C", work, "config", "core.hooksPath", hooks]);
  execFileSync("git", ["-C", work, "remote", "add", "origin", "git@github.com:cniska/thing.git"]);

  const env = { PATH: `${bin}:${process.env.PATH}`, DIM_HOME: machine, HOME: home };
  const commit = (files: Record<string, string>, extra: Record<string, string> = {}) => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(work, path), text);
    execFileSync("git", ["-C", work, "add", "-A"]);
    const run = spawnSync("git", ["-C", work, "commit", "-q", "-m", "feat: a conforming subject"], {
      encoding: "utf8",
      env: { ...process.env, ...env, ...extra },
    });
    return { ok: run.status === 0, err: run.stderr };
  };
  if (layers.project !== undefined) {
    const first = commit({ ".dim/config.json": layers.project }, { DIM_SKIP_CHECK: "1" });
    if (!first.ok) throw new Error(`could not commit the project config: ${first.err}`);
  }
  return { dir, work, env, commit };
}

describe("the comment gate", () => {
  test("refuses an added comment in a repo whose committed config bans them, naming each path and line", () => {
    const { dir, commit } = repoWithCommentGate({ project: BANNED });
    try {
      const refused = commit({ "a.ts": "const a = 1;\n// why\n", "b.ts": "/* why */\n" });
      expect(refused.ok).toBe(false);
      expect(refused.err).toContain("\n  a.ts:2\n  b.ts:1\n");
      expect(refused.err).toContain("a name, a test, or the doc that owns the subject");
      expect(refused.err).toContain("DIM_SKIP_CHECK=1 git commit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lets through a commit with no added comment, over one already there", () => {
    const { dir, commit } = repoWithCommentGate({ project: BANNED });
    try {
      expect(commit({ "a.ts": "// kept\n" }, { DIM_SKIP_CHECK: "1" }).ok).toBe(true);
      expect(commit({ "a.ts": "// kept\nconst a = 1;\n" }).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses where only the user config bans comments", () => {
    const { dir, commit } = repoWithCommentGate({ user: BANNED });
    try {
      expect(commit({ "a.ts": "// why\n" }).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("judges by the ban the last commit holds, so one commit cannot lift it and add a comment", () => {
    const { dir, commit } = repoWithCommentGate({ project: BANNED });
    try {
      const refused = commit({ ".dim/config.json": '{ "comments": "allowed" }', "a.ts": "// why\n" });
      expect(refused.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [what, layers] of [
    ["no config", {}],
    [
      "a committed config allowing comments over a user ban",
      { project: '{ "comments": "allowed" }', user: BANNED },
    ],
  ] as const) {
    test(`passes a repo with ${what}`, () => {
      const { dir, commit } = repoWithCommentGate(layers);
      try {
        expect(commit({ "a.ts": "// why\n" }).ok).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("passes on a config it cannot read, and says why", () => {
    const { dir, commit } = repoWithCommentGate({ project: '{ "comments": ' });
    try {
      const passed = commit({ "a.ts": "// why\n" });
      expect(passed.ok).toBe(true);
      expect(passed.err).toContain(".dim/config.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits 3 from the command when it names an added comment", () => {
    const { dir, work, env, commit } = repoWithCommentGate({ project: BANNED });
    try {
      commit({ "a.ts": "const a = 1;\n" });
      writeFileSync(join(work, "a.ts"), "const a = 1;\n// why\n");
      execFileSync("git", ["-C", work, "add", "-A"]);
      const run = spawnSync(process.execPath, [join(import.meta.dir, "cli.ts"), "comments", "check"], {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      expect(run.status).toBe(3);
      expect(run.stdout).toBe("a.ts:2\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("passes when dim fails with output on stdout, since only exit 3 is a refusal", () => {
    const { dir, commit } = repoWithCommentGate(
      {},
      '[ "$1 $2" = "comments check" ] && { echo "a.ts:1"; exit 1; }; exit 0',
    );
    try {
      expect(commit({ "a.ts": "// why\n" }).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("steps aside on the env escape", () => {
    const { dir, commit } = repoWithCommentGate({ project: BANNED });
    try {
      expect(commit({ "a.ts": "// why\n" }, { DIM_SKIP_CHECK: "1" }).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("whether a checkout's commit is judged for comments", () => {
  test("arms under any spelling of the shared hooks directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "dim-comment-gate-for-"));
    try {
      const env = {
        HOME: join(dir, "home"),
        GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
        DIM_HOME: join(dir, "machine"),
      };
      mkdirSync(env.DIM_HOME, { recursive: true });
      mkdirSync(join(env.HOME, ".config", "dim"), { recursive: true });
      writeFileSync(join(env.HOME, ".config", "dim", "config.json"), '{ "comments": "banned" }');
      installCommitGate(["github.com/cniska"], [], env);
      const work = join(dir, "work");
      execFileSync("git", ["init", "-q", work]);
      execFileSync("git", ["-C", work, "remote", "add", "origin", "git@github.com:cniska/thing.git"]);
      execFileSync("git", ["-C", work, "config", "core.hooksPath", `${sharedHooksDir(env)}/`]);
      expect(commentGateFor(work, "HEAD", env)).toEqual({ state: "armed", label: "cniska/thing" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
  test("runs the declared check in a repo the owner owns", () => {
    const { dir, marker } = repoRunningItsOwnCheck("git@github.com:cniska/thing.git", ["github.com/cniska"]);
    try {
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
