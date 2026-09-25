import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxedCheck } from "./sandboxed-check";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// A stand-in for the real sandbox, which cannot run nested inside the one a worker's suite runs
// in: it refuses any command naming the canary and runs everything else unconfined.
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

  test("gives the check none of the operator's factory identity", () => {
    const worktree = scratch("dim-check-worktree-");
    const canary = join(scratch("dim-check-data-"), "canary");
    const saved = process.env.DIM_WORKER_TOKEN;
    process.env.DIM_WORKER_TOKEN = "operator-token";
    try {
      const check = runSandboxedCheck({
        worktree,
        command: 'echo "token=$DIM_WORKER_TOKEN"',
        canary,
        sandbox: confiningSandbox(canary),
      });
      expect(check.output).toContain("token=\n");
    } finally {
      if (saved === undefined) delete process.env.DIM_WORKER_TOKEN;
      else process.env.DIM_WORKER_TOKEN = saved;
    }
  });
});
