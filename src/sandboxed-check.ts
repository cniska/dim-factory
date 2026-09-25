import { existsSync, rmSync } from "node:fs";
import type { ProcessEnvironment } from "./harness-process";
import { stationEnvironment } from "./station-environment";

/**
 * The check executes code the builder wrote, so it runs under the same confinement the builder
 * had: the worktree writable, the network and the operator's data refused. `codex sandbox` is
 * that confinement without a model turn.
 */
export const CHECK_SANDBOX = ["codex", "sandbox", "-c", 'sandbox_mode="workspace-write"', "--"];

// The record keeps the end of the output, where a failing check reports why.
const OUTPUT_TAIL_LINES = 200;

export type SandboxedCheck = {
  command: string;
  exitCode: number;
  output: string;
  startedAt: string;
  finishedAt: string;
};

export class SandboxNotHolding extends Error {
  readonly code = "sandbox_not_holding";
}

/**
 * Runs `command` in `worktree` under `sandbox`, after proving the sandbox refuses a write to
 * `canary` — a path outside the worktree the check must not reach. A sandbox that lets the canary
 * through is refused before the check runs, since a weakened or missing sandbox otherwise runs the
 * builder's code as the operator without any error.
 */
export function runSandboxedCheck(options: {
  worktree: string;
  command: string;
  canary: string;
  sandbox?: string[];
  env?: ProcessEnvironment;
}): SandboxedCheck {
  const sandbox = options.sandbox ?? CHECK_SANDBOX;
  const env = stationEnvironment(options.env);
  const run = (argv: string[]) => {
    try {
      return Bun.spawnSync([...sandbox, ...argv], {
        cwd: options.worktree,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      throw new SandboxNotHolding(
        `the check sandbox could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  rmSync(options.canary, { force: true });
  run(["/bin/sh", "-c", 'printf canary > "$0"', options.canary]);
  if (existsSync(options.canary)) {
    rmSync(options.canary, { force: true });
    throw new SandboxNotHolding(
      `the check sandbox let a write through to ${options.canary}, so the check was not run`,
    );
  }

  const startedAt = new Date().toISOString();
  const check = run(["/bin/sh", "-c", options.command]);
  const finishedAt = new Date().toISOString();
  const output = `${check.stdout.toString()}${check.stderr.toString()}`
    .split("\n")
    .slice(-OUTPUT_TAIL_LINES)
    .join("\n");
  return { command: options.command, exitCode: check.exitCode ?? 1, output, startedAt, finishedAt };
}
