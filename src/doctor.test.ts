import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexConfigPath, planCodexTrust } from "./codex-trust";
import { gateHooks } from "./commit-gate";
import { closeDb, openDb } from "./db";
import { diagnose } from "./doctor";
import { scratchEnv, writeClaudeTranscript } from "./fixtures.test-support";
import { installHooks } from "./hooks";
import { dbPath, type Env } from "./paths";
import { openReadOnly } from "./read-db";
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
  // HOME too, not just the DIM_* roots: doctor reads the tools' own config, and
  // a test that leaves it unset would diagnose the real machine.
  // Git's global config too, or the gate checks would read the reader's own.
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
  test("fails when retention is unset, because that deletes the sources", () => {
    const env = seeded();
    const claudeDir = join(env.HOME as string, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({}));
    const unset = check(env, "retention");
    expect(unset?.state).toBe("fail");
    expect(unset?.detail).toContain("30 days");

    // Removing the setting must flip the check, or it is not holding anything.
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 3650 }));
    expect(check(env, "retention")?.state).toBe("ok");

    // install-hooks writes into this file and keeps whatever comments it holds,
    // so a reader that cannot take one would turn the check that guards the
    // sources silent on a config dim itself made ordinary.
    writeFileSync(join(claudeDir, "settings.json"), '{\n  // kept forever\n  "cleanupPeriodDays": 3650\n}\n');
    expect(check(env, "retention")?.state).toBe("ok");
  });

  test("warns until one commit gate covers every repo", () => {
    const env = seeded();
    const missing = check(env, "commit gate");
    expect(missing?.state).toBe("warn");
    expect(missing?.fix).toContain("install-commit-gate");

    // Writing the hooks must flip it, or the check is reporting a constant. A
    // gate missing one hook is a rule back to being asked, so it still warns and
    // names which one.
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

  // A hook written before the scripts changed runs the old rules, and existence
  // alone cannot see that: the check read as every hook in place for every repo.
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

  // Git reads one hooks directory, so a gate it is not pointed at is three
  // correct files that run nowhere.
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

  // An owner list from before the host match names an account alone, which now
  // matches nothing: the gate reads as installed and arms in no repository.
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

  // The gate exits silently where this ref is missing, so the whole point of
  // reporting it is that nothing else can.
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

  test("fails when hooks are installed but have never fired", () => {
    const env = seeded();
    // No hooks in this scratch home, so the check must say it is not expected
    // yet rather than reporting a failure the owner cannot act on.
    expect(check(env, "end reasons")?.state).toBe("warn");
    expect(check(env, "hooks")?.state).toBe("fail");
  });

  // Codex writes the hook the moment install-hooks does and runs it only once
  // config.toml trusts its position, so "installed" and "running" are different
  // facts and only this check reads the second one.
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

    // An entry inserted ahead of dim's shifts every index after it, and the
    // trust recorded against the old position no longer names dim's hook.
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
      // The same file feeds both, so a hooks check reading "ok" here would say
      // collection is wired up while the file deciding that is unreadable.
      expect(by("hooks")?.state).toBe("fail");
      expect(by("end reasons")?.detail).toContain("not judged");
      expect(checks.map((c) => c.name)).toContain("schema");
    } finally {
      db.close();
    }
  });

  // An empty set of trusted keys reads as "approve your hooks in Codex", which
  // is the wrong instruction when the file holding them is what is broken.
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

  test("fails while no spawn profile is written, and clears once one reads", () => {
    const env = seeded();

    const missing = check(env, "spawn profile");
    expect(missing?.state).toBe("fail");
    expect(missing?.detail).toContain("no spawn profile");
    expect(missing?.fix).toBeTruthy();

    mkdirSync(env.DIM_HOME as string, { recursive: true });
    writeFileSync(
      join(env.DIM_HOME as string, "spawn.json"),
      JSON.stringify({
        argv: ["claude", "{brief}", "{model}", "{tools}"],
        slots: { tools: { join: "," } },
        grants: { "read-files": { tools: ["Read"] } },
      }),
    );
    expect(check(env, "spawn profile")?.state).toBe("ok");
  });

  test("fails with a repair fix while the spawn profile is malformed", () => {
    const env = seeded();
    mkdirSync(env.DIM_HOME as string, { recursive: true });
    const path = join(env.DIM_HOME as string, "spawn.json");
    writeFileSync(
      path,
      JSON.stringify({ argv: ["claude", "{model}"], slots: {}, grants: { "read-file": {} } }),
    );

    const malformed = check(env, "spawn profile");

    expect(malformed?.state).toBe("fail");
    expect(malformed?.detail).not.toContain("no spawn profile");
    expect(malformed?.fix).toContain(path);
  });

  test("reports every check with something a reader can act on", () => {
    const env = seeded();
    const db = openReadOnly(dbPath(env));
    try {
      const checks = diagnose(db, env);
      expect(checks.length).toBeGreaterThan(5);
      for (const c of checks) {
        expect(c.detail.length, `${c.name} has no detail`).toBeGreaterThan(0);
        // A failure a reader cannot act on is a complaint, not a diagnosis.
        if (c.state === "fail") expect(c.fix, `${c.name} fails with no fix`).toBeTruthy();
      }
    } finally {
      db.close();
    }
  });
});
