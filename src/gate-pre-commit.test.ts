import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { installHook, pathWithDim } from "./gate.test-support";

const SKIP = "DIM_SKIP_CHECK";
const BANNED = '{ "comments": "banned" }';

type Gate = {
  dir: string;
  work: string;
  env: Record<string, string>;
  commit: (files: Record<string, string>, env?: Record<string, string>) => { ok: boolean; err: string };
};

function repoWithCommentGate(
  layers: { project?: string; user?: string },
  dimShim = `exec "${process.execPath}" "${join(import.meta.dir, "cli.ts")}" "$@"`,
): Gate {
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
  installHook(hooks, "pre-commit", ["github.com/cniska"]);
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
    const first = commit({ ".dim/config.json": layers.project }, { [SKIP]: "1" });
    if (!first.ok) throw new Error(`could not commit the project config: ${first.err}`);
  }
  return { dir, work, env, commit };
}

function withGate(gate: Gate, check: (gate: Gate) => void): void {
  try {
    check(gate);
  } finally {
    rmSync(gate.dir, { recursive: true, force: true });
  }
}

describe("the comment gate", () => {
  test("refuses an added comment in a repo whose committed config bans them, naming each path and line", () =>
    withGate(repoWithCommentGate({ project: BANNED }), ({ commit }) => {
      const refused = commit({ "a.ts": "const a = 1;\n// why\n", "b.ts": "/* why */\n" });
      expect(refused.ok).toBe(false);
      expect(refused.err).toContain("\n  a.ts:2\n  b.ts:1\n");
      expect(refused.err).toContain("a name, a test, or the doc that owns the subject");
      expect(refused.err).toContain("DIM_SKIP_CHECK=1 git commit");
    }));

  test("lets through a commit with no added comment, over one already there", () =>
    withGate(repoWithCommentGate({ project: BANNED }), ({ commit }) => {
      expect(commit({ "a.ts": "// kept\n" }, { [SKIP]: "1" }).ok).toBe(true);
      expect(commit({ "a.ts": "// kept\nconst a = 1;\n" }).ok).toBe(true);
    }));

  test("refuses where only the user config bans comments", () =>
    withGate(repoWithCommentGate({ user: BANNED }), ({ commit }) => {
      expect(commit({ "a.ts": "// why\n" }).ok).toBe(false);
    }));

  test("judges by the ban the last commit holds, so one commit cannot lift it and add a comment", () =>
    withGate(repoWithCommentGate({ project: BANNED }), ({ commit }) => {
      expect(commit({ ".dim/config.json": '{ "comments": "allowed" }', "a.ts": "// why\n" }).ok).toBe(false);
    }));

  for (const [what, layers] of [
    ["no config", {}],
    [
      "a committed config allowing comments over a user ban",
      { project: '{ "comments": "allowed" }', user: BANNED },
    ],
  ] as const) {
    test(`passes a repo with ${what}`, () =>
      withGate(repoWithCommentGate(layers), ({ commit }) => {
        expect(commit({ "a.ts": "// why\n" }).ok).toBe(true);
      }));
  }

  test("passes on a config it cannot read, and says why", () =>
    withGate(repoWithCommentGate({ project: '{ "comments": ' }), ({ commit }) => {
      const passed = commit({ "a.ts": "// why\n" });
      expect(passed.ok).toBe(true);
      expect(passed.err).toContain(".dim/config.json");
    }));

  test("exits 3 from the gate command when it names an added comment", () =>
    withGate(repoWithCommentGate({ project: BANNED }), ({ dir, work, env, commit }) => {
      commit({ "a.ts": "const a = 1;\n" });
      writeFileSync(join(work, "a.ts"), "const a = 1;\n// why\n");
      execFileSync("git", ["-C", work, "add", "-A"]);
      const run = spawnSync(
        process.execPath,
        [join(import.meta.dir, "cli.ts"), "gate", join(dir, "hooks", "pre-commit")],
        { cwd: work, encoding: "utf8", env: { ...process.env, ...env } },
      );
      expect(run.status).toBe(3);
      expect(run.stderr).toContain("\n  a.ts:2\n");
    }));

  test("passes when dim fails, since only the refusal exit refuses", () =>
    withGate(repoWithCommentGate({ project: BANNED }, 'echo "a.ts:1" >&2; exit 1'), ({ commit }) => {
      const passed = commit({ "a.ts": "// why\n" });
      expect(passed.ok).toBe(true);
      expect(passed.err).toContain("pre-commit: dim gate exited 1, so this is not judged.");
    }));

  test("steps aside on the env escape", () =>
    withGate(repoWithCommentGate({ project: BANNED }), ({ commit }) => {
      expect(commit({ "a.ts": "// why\n" }, { [SKIP]: "1" }).ok).toBe(true);
    }));
});

const CLEAN_GIT_ENVIRONMENT =
  'test -z "$GIT_INDEX_FILE$GIT_DIR$GIT_AUTHOR_NAME$GIT_AUTHOR_EMAIL$GIT_AUTHOR_DATE"';

function repoDeclaringCheck(script: string): Gate & { commits: () => number } {
  const gate = repoWithCommentGate({});
  const declared = gate.commit(
    { "package.json": JSON.stringify({ scripts: { verify: script } }), "bun.lock": "" },
    { [SKIP]: "1" },
  );
  if (!declared.ok) throw new Error(`could not commit the declared check: ${declared.err}`);
  const commits = () =>
    Number(
      execFileSync("git", ["-C", gate.work, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(),
    );
  return { ...gate, commits };
}

describe("the check gate", () => {
  test("refuses a real commit whose declared check fails, and names the way past it", () => {
    const gate = repoDeclaringCheck("exit 1");
    withGate(gate, ({ commit }) => {
      const refused = commit({ "a.ts": "export const a = 1;\n" });
      expect(refused.ok).toBe(false);
      expect(refused.err).toContain("pre-commit: bun run verify");
      expect(refused.err).toContain("the repo's own check failed, so the commit is refused");
      expect(refused.err).toContain("DIM_SKIP_CHECK=1 git commit");
      expect(gate.commits()).toBe(1);
    });
  });

  test("lets a commit through when its declared check passes", () => {
    const gate = repoDeclaringCheck("exit 0");
    withGate(gate, ({ commit }) => {
      expect(commit({ "a.ts": "export const a = 1;\n" }).ok).toBe(true);
      expect(gate.commits()).toBe(2);
    });
  });

  test("steps aside on the env escape, over a failing check", () => {
    const gate = repoDeclaringCheck("exit 1");
    withGate(gate, ({ commit }) => {
      expect(commit({ "a.ts": "export const a = 1;\n" }, { [SKIP]: "1" }).ok).toBe(true);
      expect(gate.commits()).toBe(2);
    });
  });

  test("lets a commit through where dim is missing, over a failing check, and says it was not judged", () => {
    const gate = repoDeclaringCheck("exit 1");
    withGate(gate, ({ dir, commit }) => {
      rmSync(join(dir, "bin", "dim"));
      const pathWithoutDim = `${process.env.PATH}`
        .split(delimiter)
        .filter((entry) => !existsSync(join(entry, "dim")))
        .join(delimiter);
      const passed = commit({ "a.ts": "export const a = 1;\n" }, { PATH: pathWithoutDim });
      expect(passed.ok).toBe(true);
      expect(passed.err).toContain("pre-commit: dim is not on PATH, so this is not judged.");
      expect(gate.commits()).toBe(2);
    });
  });

  test("lets a commit through in a repo that declares no check", () =>
    withGate(repoWithCommentGate({}), ({ commit }) => {
      expect(commit({ "a.ts": "export const a = 1;\n" }).ok).toBe(true);
    }));

  test("runs the check outside the committing repo's git environment", () => {
    const gate = repoDeclaringCheck(CLEAN_GIT_ENVIRONMENT);
    withGate(gate, ({ commit }) => {
      const run = commit({ "a.ts": "export const a = 1;\n" });
      expect(run.err).not.toContain("the repo's own check failed");
      expect(run.ok).toBe(true);
      expect(gate.commits()).toBe(2);
    });
  });
});

function repoRunningItsOwnCheck(origin: string, owners: string[]): { dir: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "dim-arm-"));
  const hooks = join(dir, "hooks");
  const work = join(dir, "work");
  const marker = join(dir, "marker");
  installHook(hooks, "pre-commit", owners);

  execFileSync("git", ["init", "-q", work]);
  execFileSync("git", ["-C", work, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", work, "config", "user.name", "T"]);
  execFileSync("git", ["-C", work, "config", "core.hooksPath", hooks]);
  execFileSync("git", ["-C", work, "remote", "add", "origin", origin]);

  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ scripts: { verify: `printf pwned > ${marker}` } }),
  );
  writeFileSync(join(work, "bun.lock"), "");
  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", ["-C", work, "commit", "-m", "feat: a conforming subject"], {
    stdio: "pipe",
    env: { ...process.env, PATH: pathWithDim(), HOME: dir },
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
