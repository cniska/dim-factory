import { existsSync, rmSync } from "node:fs";
import type { ProcessEnvironment } from "./harness-process";
import { stationEnvironment } from "./station-environment";

export const CHECK_SANDBOX = ["codex", "sandbox", "-c", 'sandbox_mode="workspace-write"', "--"];

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
