export type GroupRun = {
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
};

export function killProcessGroup(leader: number): void {
  try {
    process.kill(-leader, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

export function runGroup(
  argv: readonly string[],
  {
    cwd,
    env,
    limitMs,
  }: { readonly cwd: string; readonly env: Record<string, string>; readonly limitMs: number },
): GroupRun {
  const ran = Bun.spawnSync([...argv], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: limitMs,
    detached: true,
  });
  killProcessGroup(ran.pid);
  return {
    exitCode: ran.exitCode,
    output: `${ran.stdout.toString()}${ran.stderr.toString()}`,
    timedOut: ran.exitedDueToTimeout === true,
  };
}
