import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnv, limitReached, outputTail, sandboxProfile } from "./check";
import type { Evidence } from "./order-contract";
import type { Env } from "./paths";
import type { Trace } from "./trace-contract";

export type Sandboxed = { readonly exitCode: number | null; readonly output: string };

function runSandboxed(tree: string, commandLine: string, owner: Env, limitMs: number): Sandboxed {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dim-check-")));
  try {
    const profile = sandboxProfile([realpathSync(tree), tmp]);
    const ran = Bun.spawnSync(["sandbox-exec", "-p", profile, "sh", "-c", `${commandLine} 2>&1`], {
      cwd: tree,
      env: checkEnv(owner, tmp),
      stdout: "pipe",
      stderr: "pipe",
      timeout: limitMs,
      detached: true,
    });
    killGroup(ran.pid);
    const output = `${ran.stdout.toString()}${ran.stderr.toString()}`;
    return {
      exitCode: ran.exitCode,
      output: outputTail(ran.exitedDueToTimeout ? `${output}${limitReached(limitMs)}` : output),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function runCheck(
  trace: Trace,
  tree: string,
  commandLine: string,
  owner: Env,
  limitMs: number,
): Evidence {
  return trace.step(
    "check",
    { tree, command: commandLine },
    (): Evidence => ({
      kind: "check",
      command: commandLine,
      ...runSandboxed(tree, commandLine, owner, limitMs),
    }),
    (evidence) => ({ exitCode: evidence.exitCode }),
  );
}

export function runInstall(
  trace: Trace,
  tree: string,
  commandLine: string,
  owner: Env,
  limitMs: number,
): Sandboxed {
  return trace.step(
    "install",
    { tree, command: commandLine },
    () => runSandboxed(tree, commandLine, owner, limitMs),
    (installed) => ({ exitCode: installed.exitCode }),
  );
}

function killGroup(leader: number): void {
  try {
    process.kill(-leader, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
