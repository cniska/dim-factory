import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexConfigPath, planCodexTrust } from "./codex-trust";
import { gateHooks, installCommitGate } from "./commit-gate";
import { closeDb, openDb } from "./db";
import { diagnose } from "./doctor";
import { scratchEnv, writeClaudeTranscript } from "./fixtures.test-support";
import { installHooks } from "./hooks";
import { dbPath, type Env } from "./paths";
import { openReadOnly } from "./read-db";
import { installSkill } from "./skill";
import { sync } from "./sync";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dim-doctor-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function seeded(): Env {
  const root = newRoot();
  const env = { ...scratchEnv(root), HOME: join(root, "home"), GIT_CONFIG_GLOBAL: join(root, "gitconfig") };
  writeClaudeTranscript(env, "-Users-x-code-demo", "11111111-2222-3333-4444-555555555555");
  const db = openDb(dbPath(env));
  sync(db, env);
  closeDb(db);
  return env;
}

function pointGitAt(env: Env, dir: string): void {
  execFileSync("git", ["config", "--global", "core.hooksPath", dir], {
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
  });
}

function check(env: Env, name: string) {
  const db = openReadOnly(dbPath(env));
  try {
    return diagnose(db, env).find((c) => c.name === name);
  } finally {
    db.close();
  }
}

describe("doctor", () => {
  test("warns on a link to a skill that no longer ships", () => {
    const env = seeded();
    installSkill(env);
    expect(check(env, "skill")?.state).toBe("ok");

    const stale = join(env.HOME as string, ".codex", "skills", "dim-retired");
    symlinkSync(join(dirname(import.meta.dir), "skills", "dim-retired"), stale);
    const retired = check(env, "skill");
    expect(retired?.state).toBe("warn");
    expect(retired?.detail).toContain(stale);
    expect(retired?.fix).toBe("dim install-skill --write");
  });

  test("fails when retention is unset, because that deletes the sources", () => {
    const env = seeded();
    const claudeDir = join(env.HOME as string, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({}));
    const unset = check(env, "retention");
    expect(unset?.state).toBe("fail");
    expect(unset?.detail).toContain("30 days");

    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 3650 }));
    expect(check(env, "retention")?.state).toBe("ok");

    writeFileSync(join(claudeDir, "settings.json"), '{\n  // kept forever\n  "cleanupPeriodDays": 3650\n}\n');
    expect(check(env, "retention")?.state).toBe("ok");
  });

  test("warns until one commit gate covers every repo", () => {
    const env = seeded();
    const missing = check(env, "commit gate");
    expect(missing?.state).toBe("warn");
    expect(missing?.fix).toContain("install-commit-gate");

    const hooks = join(env.HOME as string, ".config", "dim", "hooks");
    mkdirSync(hooks, { recursive: true });
    pointGitAt(env, hooks);
    const bodies = gateHooks(["github.com/an-account"]);
    const bodyOf = (name: string) => bodies.find((h) => h.name === name)?.body ?? "";
    writeFileSync(join(hooks, "commit-msg"), bodyOf("commit-msg"));
    writeFileSync(join(hooks, "pre-commit"), bodyOf("pre-commit"));
    const partial = check(env, "commit gate");
    expect(partial?.state).toBe("warn");
    expect(partial?.detail).toContain("pre-push");

    writeFileSync(join(hooks, "pre-push"), bodyOf("pre-push"));
    expect(check(env, "commit gate")?.state).toBe("ok");
  });

  test("names a hook whose body is not the one the gate now writes", () => {
    const env = seeded();
    const hooks = join(env.HOME as string, ".config", "dim", "hooks");
    mkdirSync(hooks, { recursive: true });
    pointGitAt(env, hooks);
    for (const { name, body } of gateHooks(["github.com/an-account"])) {
      writeFileSync(join(hooks, name), body);
    }
    expect(check(env, "commit gate")?.state).toBe("ok");

    writeFileSync(join(hooks, "pre-push"), "#!/usr/bin/env bash\nexit 0\n");
    const stale = check(env, "commit gate");
    expect(stale?.state).toBe("warn");
    expect(stale?.detail).toContain("pre-push");
    expect(stale?.fix).toContain("install-commit-gate");
  });

  test("names a gate git is not pointed at", () => {
    const env = seeded();
    const hooks = join(env.HOME as string, ".config", "dim", "hooks");
    mkdirSync(hooks, { recursive: true });
    for (const { name, body } of gateHooks(["github.com/an-account"])) {
      writeFileSync(join(hooks, name), body);
    }
    const unset = check(env, "commit gate");
    expect(unset?.state).toBe("warn");
    expect(unset?.detail).toContain("core.hooksPath is unset");

    const theirs = join(env.HOME as string, "someone-elses-hooks");
    mkdirSync(theirs, { recursive: true });
    pointGitAt(env, theirs);
    const taken = check(env, "commit gate");
    expect(taken?.state).toBe("warn");
    expect(taken?.detail).toContain(theirs);

    pointGitAt(env, hooks);
    expect(check(env, "commit gate")?.state).toBe("ok");
  });

  test("names an owner that would arm the gate nowhere", () => {
    const env = seeded();
    const hooks = join(env.HOME as string, ".config", "dim", "hooks");
    mkdirSync(hooks, { recursive: true });

    writeFileSync(join(hooks, "commit-msg"), gateHooks(["github.com/an-account"])[0]?.body ?? "");
    const clean = check(env, "gate owners");
    expect(clean?.state).toBe("ok");
    expect(clean?.detail).toContain("1 owners");

    writeFileSync(join(hooks, "commit-msg"), gateHooks(["an-account"])[0]?.body ?? "");
    const bare = check(env, "gate owners");
    expect(bare?.state).toBe("fail");
    expect(bare?.detail).toContain("an-account");
  });

  test("names a checkout the push gate can never fire in", () => {
    const env = seeded();
    expect(check(env, "push gate")?.state).toBe("ok");

    const repo = join(newRoot(), "started");
    const isolated = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: isolated });
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:cniska/started.git"], {
      env: isolated,
    });

    const db = openDb(dbPath(env));
    db.run(
      "INSERT INTO repo_commit (sha, repo, label, ts, author, subject) VALUES ('s1', ?, 'cniska/started', '2026-01-01T00:00:00Z', 'a', 'feat: x')",
      [repo],
    );
    closeDb(db);

    const warned = check(env, "push gate");
    expect(warned?.state).toBe("warn");
    expect(warned?.detail).toContain("started");
    expect(warned?.fix).toContain("set-head");
  });

  test("names a checkout the factory ships from that declares no ship method", () => {
    const env = seeded();
    expect(check(env, "ship method")?.state).toBe("ok");

    const isolated = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
    const factoryRepo = join(newRoot(), "shipped");
    const otherRepo = join(newRoot(), "unrelated");
    for (const repo of [factoryRepo, otherRepo]) {
      execFileSync("git", ["init", "-q", "-b", "main", repo], { env: isolated });
    }
    const gitIn = (dir: string, args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
        env: isolated,
      });
    gitIn(factoryRepo, ["commit", "-q", "--allow-empty", "-m", "feat: x"]);
    const factoryWorktree = join(newRoot(), "shipped-wt");
    gitIn(factoryRepo, ["worktree", "add", "-q", "-b", "o1", factoryWorktree]);
    const db = openDb(dbPath(env));
    db.run(
      "INSERT INTO repo_commit (sha, repo, label, ts, author, subject) VALUES ('s1', ?, 'cniska/shipped', '2026-01-01T00:00:00Z', 'a', 'feat: x'), ('s2', ?, 'cniska/unrelated', '2026-01-01T00:00:00Z', 'a', 'feat: y')",
      [factoryWorktree, otherRepo],
    );
    db.run(
      "INSERT INTO factory_order (id, project, title, status, created_at, updated_at) VALUES ('o1', 'cniska/shipped', 'Shipped', 'queued', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    );
    closeDb(db);
    const throughWorktree = check(env, "ship method");
    expect(throughWorktree?.state).toBe("warn");
    expect(throughWorktree?.detail).toEndWith(factoryRepo.replace(`${env.HOME}/`, ""));

    const both = openDb(dbPath(env));
    both.run(
      "INSERT INTO repo_commit (sha, repo, label, ts, author, subject) VALUES ('s3', ?, 'cniska/shipped', '2026-01-01T00:00:00Z', 'a', 'feat: z')",
      [factoryRepo],
    );
    closeDb(both);

    const warned = check(env, "ship method");
    expect(warned?.state).toBe("warn");
    expect(warned?.detail).toStartWith("1 checkouts");
    expect(warned?.detail).toEndWith(factoryRepo.replace(`${env.HOME}/`, ""));
    expect(warned?.detail).not.toContain("unrelated");
    expect(warned?.fix).toBe("git config dim.ship trunk, in each");

    execFileSync("git", ["-C", factoryRepo, "config", "dim.ship", "main"], { env: isolated });
    expect(check(env, "ship method")?.state).toBe("warn");

    execFileSync("git", ["-C", factoryRepo, "config", "dim.ship", "pull-request"], { env: isolated });
    expect(check(env, "ship method")?.state).toBe("warn");

    execFileSync("git", ["-C", factoryRepo, "config", "dim.ship", "trunk"], { env: isolated });
    expect(check(env, "ship method")?.state).toBe("ok");
  });

  test("fails when hooks are installed but have never fired", () => {
    const env = seeded();
    expect(check(env, "end reasons")?.state).toBe("warn");
    expect(check(env, "hooks")?.state).toBe("fail");
  });

  test("fails while a codex hook has no trust recorded for its position", () => {
    const env = seeded();
    const config = codexConfigPath(env);
    mkdirSync(dirname(config), { recursive: true });
    installHooks(env);

    const untrusted = check(env, "codex trust");
    expect(untrusted?.state).toBe("fail");
    expect(untrusted?.detail).toContain("session_start:0:0");

    const keys = planCodexTrust(env).map((t) => t.key as string);
    writeFileSync(config, keys.map((k) => `[hooks.state."${k}"]\ntrusted_hash = "sha256:abc"\n`).join("\n"));
    expect(check(env, "codex trust")?.state).toBe("ok");

    const hooksPath = join(dirname(config), "hooks.json");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as { hooks: Record<string, unknown[]> };
    hooks.hooks.SessionStart?.unshift({ hooks: [{ type: "command", command: "other-tool" }] });
    writeFileSync(hooksPath, JSON.stringify(hooks));
    expect(check(env, "codex trust")?.state).toBe("fail");
  });

  test("reports an unreadable codex config as one failure, keeping the other checks", () => {
    const env = seeded();
    const config = codexConfigPath(env);
    mkdirSync(dirname(config), { recursive: true });
    installHooks(env);
    writeFileSync(join(dirname(config), "hooks.json"), '{ "hooks": ');

    const db = openReadOnly(dbPath(env));
    try {
      const checks = diagnose(db, env);
      const by = (name: string) => checks.find((c) => c.name === name);
      expect(by("codex trust")?.state).toBe("fail");
      expect(by("hooks")?.state).toBe("fail");
      expect(by("end reasons")?.detail).toContain("not judged");
      expect(checks.map((c) => c.name)).toContain("schema");
    } finally {
      db.close();
    }
  });

  test("reports an unparseable codex config.toml rather than reading it as no trust", () => {
    const env = seeded();
    const config = codexConfigPath(env);
    mkdirSync(dirname(config), { recursive: true });
    installHooks(env);
    writeFileSync(config, "= 1\n");

    const trust = check(env, "codex trust");
    expect(trust?.state).toBe("fail");
    expect(trust?.detail).toContain(config);
    expect(trust?.detail).not.toContain("trusted_hash");
  });

  test("reports every check with something a reader can act on", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const checks = diagnose(db, env);
      expect(checks.length).toBeGreaterThan(5);
      for (const c of checks) {
        expect(c.detail.length, `${c.name} has no detail`).toBeGreaterThan(0);
        if (c.state === "fail") expect(c.fix, `${c.name} fails with no fix`).toBeTruthy();
      }
    } finally {
      db.close();
    }
  });
});

describe("harness readiness", () => {
  function machine(binaries: string[], routing: string | null): Env {
    const env = seeded();
    const bin = join(newRoot(), "bin");
    mkdirSync(bin);
    for (const name of binaries) {
      writeFileSync(join(bin, name), "#!/bin/sh\n");
      execFileSync("chmod", ["+x", join(bin, name)]);
    }
    mkdirSync(env.DIM_HOME as string, { recursive: true });
    if (routing) writeFileSync(join(env.DIM_HOME as string, "routing.json"), routing);
    return { ...env, PATH: bin };
  }
  const MAP = '{ "light": "a", "standard": "b", "deep": "c" }';

  test("names each harness a station can run under", () => {
    const env = machine(["codex", "claude"], `{ "codex": ${MAP}, "claude": ${MAP} }`);

    expect(check(env, "harnesses")).toEqual({
      name: "harnesses",
      state: "ok",
      detail: "codex, claude ready: each is on PATH and mapped in routing.json",
    });
  });

  test("names a harness that is installed and not routed, or routed and not installed", () => {
    const env = machine(["codex", "claude"], `{ "codex": ${MAP} }`);

    expect(check(env, "harnesses")).toMatchObject({
      state: "warn",
      detail: "codex ready; claude is on PATH but routing.json has no claude map",
      fix: "add a claude map to routing.json",
    });
    expect(check(machine([], `{ "codex": ${MAP} }`), "harnesses")).toMatchObject({
      state: "warn",
      detail: "no harness is ready; codex is mapped in routing.json but not on PATH",
      fix: "install codex, or remove its map",
    });
  });

  test("warns when no harness is ready at all, since no station could start a worker", () => {
    expect(check(machine([], null), "harnesses")).toEqual({
      name: "harnesses",
      state: "warn",
      detail: "no harness is ready, so no station can start a worker",
      fix: "install codex or claude and map it in routing.json",
    });
  });

  test("fails on a routing.json no harness can be read from, and still reports every other check", () => {
    for (const routing of ['{ "codex": ["a"] }', '{ "codex": ']) {
      const env = machine(["codex"], routing);

      expect(check(env, "harnesses")).toMatchObject({
        state: "fail",
        fix: `repair ${join(env.DIM_HOME as string, "routing.json")} by hand`,
      });
      expect(check(env, "spool")).toBeDefined();
    }
  });

  test("leaves alone a harness that is neither installed nor routed", () => {
    const env = machine(["codex"], `{ "codex": ${MAP} }`);

    expect(check(env, "harnesses")).toMatchObject({
      state: "ok",
      detail: expect.stringContaining("codex ready"),
    });
  });
});

describe("the comment gate for the current repo", () => {
  function inRepo(setting: string | null): { env: Env; cwd: string } {
    const env = seeded();
    const cwd = join(newRoot(), "work");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:cniska/thing.git"]);
    mkdirSync(join(env.HOME as string, ".config", "dim"), { recursive: true });
    if (setting !== null) writeFileSync(join(env.HOME as string, ".config", "dim", "config.json"), setting);
    return { env, cwd };
  }

  function diagnoseIn(env: Env, cwd: string) {
    const db = openReadOnly(dbPath(env));
    try {
      return diagnose(db, env, cwd);
    } finally {
      db.close();
    }
  }

  function commentGate(env: Env, cwd: string) {
    return diagnoseIn(env, cwd).find((c) => c.name === "comment gate");
  }

  test("reports it off where the setting does not name the repo", () => {
    const { env, cwd } = inRepo(null);
    expect(commentGate(env, cwd)).toMatchObject({
      state: "ok",
      detail: expect.stringContaining("off for cniska/thing"),
    });
  });

  test("reports it on where the setting names the repo and the commit gate covers it", () => {
    const { env, cwd } = inRepo('{ "comments": "banned" }');
    installCommitGate(["github.com/cniska"], [], env);
    expect(commentGate(env, cwd)).toMatchObject({
      state: "ok",
      detail: expect.stringContaining("on for cniska/thing"),
    });
  });

  test("warns where the setting bans comments but the repo runs its own hooks", () => {
    const { env, cwd } = inRepo('{ "comments": "banned" }');
    installCommitGate(["github.com/cniska"], [], env);
    execFileSync("git", ["-C", cwd, "config", "core.hooksPath", ".githooks"]);
    expect(commentGate(env, cwd)).toMatchObject({
      state: "warn",
      detail: expect.stringContaining("git runs its hooks from .githooks"),
    });
  });

  test("fails the check, and still reports, where git cannot read its config", () => {
    const { env, cwd } = inRepo('{ "comments": "banned" }');
    installCommitGate(["github.com/cniska"], [], env);
    writeFileSync(env.GIT_CONFIG_GLOBAL as string, "[core\n");
    expect(commentGate(env, cwd)).toMatchObject({
      state: "fail",
      detail: expect.stringMatching(
        /^git config --type=path --get core\.hooksPath failed in .*: .*bad config line 1/,
      ),
    });
  });

  test("reports the commit gate, not the repository's hooks, where git's global hooksPath is unset", () => {
    const { env, cwd } = inRepo('{ "comments": "banned" }');
    installCommitGate(["github.com/cniska"], [], env);
    execFileSync("git", ["config", "--global", "--unset", "core.hooksPath"], {
      env: { ...process.env, ...env },
    });
    expect(commentGate(env, cwd)).toMatchObject({
      state: "warn",
      detail: "banned for cniska/thing, not on until the commit gate is",
    });
  });

  test("warns where the setting bans comments but no hook covers the repo", () => {
    const { env, cwd } = inRepo('{ "comments": "banned" }');
    installCommitGate(["github.com/someone-else"], [], env);
    expect(commentGate(env, cwd)).toMatchObject({
      state: "warn",
      fix: expect.stringContaining("install-commit-gate"),
    });
  });

  test("warns where the installed pre-commit hook is not the one that carries the comment step", () => {
    const { env, cwd } = inRepo('{ "comments": "banned" }');
    installCommitGate(["github.com/cniska"], [], env);
    writeFileSync(
      join(env.HOME as string, ".config", "dim", "hooks", "pre-commit"),
      "#!/usr/bin/env bash\nexit 0\n",
    );
    const checks = diagnoseIn(env, cwd);
    expect(checks.find((c) => c.name === "commit gate")).toMatchObject({
      state: "warn",
      detail: expect.stringContaining("pre-commit is stale"),
    });
    expect(checks.find((c) => c.name === "comment gate")).toEqual({
      name: "comment gate",
      state: "warn",
      detail: "banned for cniska/thing, not on until the commit gate is",
    });
  });

  for (const [what, setting] of [
    ["holds a value it refuses", '{ "comments": 1 }'],
    ["does not parse", '{ "comments": '],
  ]) {
    test(`fails on a config that ${what}, and names the file`, () => {
      const { env, cwd } = inRepo(setting as string);
      expect(commentGate(env, cwd)).toMatchObject({
        state: "fail",
        fix: `repair ${join(env.HOME as string, ".config", "dim", "config.json")} by hand`,
      });
    });
  }

  test("judges nothing outside a checkout", () => {
    const env = seeded();
    expect(commentGate(env, newRoot())).toMatchObject({
      state: "ok",
      detail: expect.stringContaining("not judged"),
    });
  });
});
