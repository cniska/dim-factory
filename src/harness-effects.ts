import type { Spawn, Spawned } from "./harness-contract";
import { killProcessGroup } from "./process-group";
import type { Trace } from "./trace-contract";

async function linesOf(stream: ReadableStream<Uint8Array>): Promise<readonly string[]> {
  return (await new Response(stream).text()).split("\n").filter((line) => line.trim() !== "");
}

export function killGroup(trace: Trace, pid: number): void {
  trace.step("harness_kill", { harness: pid }, () => killProcessGroup(pid));
}

export function spawnHarness(trace: Trace, { argv, cwd, env, session }: Spawn): Spawned {
  const child = trace.step(
    "harness_spawn",
    { cwd, session },
    () =>
      Bun.spawn([...argv], {
        cwd,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      }),
    (spawned) => ({ harness: spawned.pid }),
  );
  return {
    pid: child.pid,
    prompt(text) {
      child.stdin.write(text);
      child.stdin.end();
    },
    kill() {
      killGroup(trace, child.pid);
    },
    ended: trace.stepAsync(
      "harness_wait",
      { harness: child.pid },
      async () => {
        const [lines, stderr] = await Promise.all([
          linesOf(child.stdout),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { lines, stderr, exitCode: child.exitCode };
      },
      (ended) => ({ exitCode: ended.exitCode }),
    ),
  };
}
