import type { Spawn, Spawned } from "./harness-contract";
import { killProcessGroup } from "./process-group";
import type { Trace } from "./trace-contract";

async function linesOf(
  stream: ReadableStream<Uint8Array>,
  heard: (line: string) => void,
): Promise<readonly string[]> {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let rest = "";
  const take = (line: string) => {
    if (line.trim() === "") return;
    lines.push(line);
    heard(line);
  };
  for await (const chunk of stream) {
    const text = rest + decoder.decode(chunk, { stream: true });
    const parts = text.split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) take(line);
  }
  take(rest + decoder.decode());
  return lines;
}

export function killGroup(trace: Trace, pid: number): void {
  trace.step("harness_kill", { harness: pid }, () => killProcessGroup(pid));
}

export function spawnHarness(trace: Trace, { argv, cwd, env, session, heard }: Spawn): Spawned {
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
          linesOf(child.stdout, heard),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { lines, stderr, exitCode: child.exitCode };
      },
      (ended) => ({ exitCode: ended.exitCode }),
    ),
  };
}
