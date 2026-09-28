import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxedCheck } from "./check-sandbox";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function confiningSandbox(canary: string): string[] {
  const script = join(scratch("dim-fake-sandbox-"), "sandbox");
  writeFileSync(script, `#!/bin/sh\ncase "$*" in *"${canary}"*) exit 1 ;; esac\nexec "$@"\n`);
  chmodSync(script, 0o755);
  return [script];
}

describe("running a repo's check in a sandbox", () => {
  test("refuses to run the check when the sandbox lets the canary through", () => {
    const worktree = scratch("dim-check-worktree-");
    const canary = join(scratch("dim-check-data-"), "canary");

    expect(() => runSandboxedCheck({ worktree, command: "touch ran", canary, sandbox: [] })).toThrow(
      expect.objectContaining({ code: "sandbox_not_holding" }),
    );
    expect(existsSync(join(worktree, "ran"))).toBe(false);
    expect(existsSync(canary)).toBe(false);
  });

  test("refuses, with the same code, when the sandbox cannot start at all", () => {
    const worktree = scratch("dim-check-worktree-");
    const canary = join(scratch("dim-check-data-"), "canary");

    expect(() =>
      runSandboxedCheck({ worktree, command: "true", canary, sandbox: ["/no/such/sandbox"] }),
    ).toThrow(expect.objectContaining({ code: "sandbox_not_holding" }));
  });

  test("a canary left by an earlier run does not read as a sandbox that leaks", () => {
    const worktree = scratch("dim-check-worktree-");
    const canary = join(scratch("dim-check-data-"), "canary");
    writeFileSync(canary, "left behind");

    expect(
      runSandboxedCheck({ worktree, command: "true", canary, sandbox: confiningSandbox(canary) }).exitCode,
    ).toBe(0);
  });

  test("runs the check in the worktree and reports its exit code and output", () => {
    const worktree = scratch("dim-check-worktree-");
    const canary = join(scratch("dim-check-data-"), "canary");

    const check = runSandboxedCheck({
      worktree,
      command: "pwd; echo failing >&2; exit 3",
      canary,
      sandbox: confiningSandbox(canary),
    });

    expect(check).toMatchObject({ command: "pwd; echo failing >&2; exit 3", exitCode: 3 });
    expect(check.output).toContain(worktree);
    expect(check.output).toContain("failing");
    expect(Date.parse(check.finishedAt)).toBeGreaterThanOrEqual(Date.parse(check.startedAt));
  });

  test("gives the check none of the operator's factory name", () => {
    const worktree = scratch("dim-check-worktree-");
    const canary = join(scratch("dim-check-data-"), "canary");
    const saved = process.env.DIM_WORKER_NAME;
    process.env.DIM_WORKER_NAME = "operator-1";
    try {
      const check = runSandboxedCheck({
        worktree,
        command: 'echo "name=$DIM_WORKER_NAME"',
        canary,
        sandbox: confiningSandbox(canary),
      });
      expect(check.output).toContain("name=\n");
    } finally {
      if (saved === undefined) delete process.env.DIM_WORKER_NAME;
      else process.env.DIM_WORKER_NAME = saved;
    }
  });

  test("gives the check no credential of the owner's, only the variables a process needs to run", () => {
    const worktree = scratch("dim-check-worktree-");
    const canary = join(scratch("dim-check-data-"), "canary");
    const owner = {
      GH_TOKEN: "gh-token",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      ANTHROPIC_API_KEY: "sk-ant",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      HTTPS_PROXY: "http://user:pass@proxy:3128",
      DIM_HOME: "/owner/dim",
      LANG: "C.UTF-8",
    };
    const saved = Object.fromEntries(Object.keys(owner).map((name) => [name, process.env[name]]));
    Object.assign(process.env, owner);
    try {
      const check = runSandboxedCheck({
        worktree,
        command: "env",
        canary,
        sandbox: confiningSandbox(canary),
        env: { PATH: process.env.PATH ?? "" },
      });
      const names = check.output.split("\n").map((line) => line.split("=")[0]);
      expect(names).toContain("PATH");
      expect(names).toContain("HOME");
      expect(names).toContain("LANG");
      for (const name of Object.keys(owner).filter((name) => name !== "LANG"))
        expect(names).not.toContain(name);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
