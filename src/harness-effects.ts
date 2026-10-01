import type { Spawned } from "./harness-contract";

async function linesOf(stream: ReadableStream<Uint8Array>): Promise<readonly string[]> {
  return (await new Response(stream).text()).split("\n").filter((line) => line.trim() !== "");
}

export function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export function spawnHarness(argv: readonly string[], cwd: string, env: Record<string, string>): Spawned {
  const child = Bun.spawn([...argv], {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  return {
    pid: child.pid,
    prompt(text) {
      child.stdin.write(text);
      child.stdin.end();
    },
    kill() {
      killGroup(child.pid);
    },
    ended: Promise.all([linesOf(child.stdout), new Response(child.stderr).text(), child.exited]).then(
      ([lines, stderr]) => ({ lines, stderr, exitCode: child.exitCode }),
    ),
  };
}
