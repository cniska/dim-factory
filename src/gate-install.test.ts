import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookBody } from "./gate-hooks";
import { installCommitGate, installedOwners, sharedHooksDir } from "./gate-install";

function inHome(check: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "dim-home-"));
  try {
    check(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("installing the commit gate", () => {
  test("puts the one hooks directory under the reader's own config directory", () =>
    inHome((home) => {
      expect(sharedHooksDir({ HOME: home })).toBe(join(home, ".config", "dim", "hooks"));
    }));

  test("refuses a global hooks path it does not own, without touching anything", () =>
    inHome((home) => {
      const theirs = join(home, "theirs");
      const checkout = join(home, "repo");
      const perRepo = join(checkout, ".git", "hooks", "commit-msg");
      mkdirSync(join(checkout, ".git", "hooks"), { recursive: true });
      mkdirSync(theirs);
      writeFileSync(perRepo, "#!/bin/sh\nexit 0\n");
      const env = { HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig") };
      execFileSync("git", ["config", "--global", "core.hooksPath", theirs], {
        env: { ...process.env, ...env },
      });

      expect(() => installCommitGate(["github.com/cniska"], [checkout], env)).toThrow(
        expect.objectContaining({ code: "gate_hooks_path_taken", meta: { existing: theirs } }),
      );

      expect(existsSync(join(sharedHooksDir(env), "commit-msg"))).toBe(false);
      expect(existsSync(perRepo)).toBe(true);
      expect(
        execFileSync("git", ["config", "--global", "--get", "core.hooksPath"], {
          env: { ...process.env, ...env },
          encoding: "utf8",
        }).trim(),
      ).toBe(theirs);
    }));

  test("writes every hook the gate owns, and reports each one", () =>
    inHome((home) => {
      const env = { HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig") };
      const plan = installCommitGate(["github.com/cniska"], [], env);
      expect(plan.hooks.map((hook) => hook.name)).toEqual(["commit-msg", "pre-commit", "pre-push"]);
      for (const hook of plan.hooks) {
        expect(hook.state).toBe("installed");
        expect(existsSync(join(sharedHooksDir(env), hook.name))).toBe(true);
      }
    }));

  test("the owner list is the only thing that changes between installs", () => {
    expect(hookBody(["cniska"])).not.toEqual(hookBody(["cniska", "other-org"]));
    expect(hookBody(["cniska", "other-org"])).toContain('# dim-owners: ["cniska","other-org"]');
  });

  for (const [what, body] of [
    ["a malformed owner declaration", "# dim-owners: [broken\n"],
    ["no owner declaration", "#!/bin/sh\nexit 0\n"],
  ] as const) {
    test(`refuses to read ${what}, naming the hook`, () =>
      inHome((home) => {
        const dir = sharedHooksDir({ HOME: home });
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "commit-msg"), body);
        expect(() => installedOwners({ HOME: home })).toThrow(
          expect.objectContaining({
            code: "gate_unreadable_owners",
            meta: { path: join(dir, "commit-msg") },
          }),
        );
      }));
  }

  test("reads an owner path containing a Unicode line separator", () =>
    inHome((home) => {
      const dir = sharedHooksDir({ HOME: home });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "commit-msg"), hookBody(["/tmp/team name"]));
      expect(installedOwners({ HOME: home })).toEqual(["/tmp/team name"]);
    }));
});
