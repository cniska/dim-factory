import type { HarnessAdapter, HarnessEvent, HarnessRequest, HarnessRun } from "./harness";

type HarnessProcessOptions = {
  name: string;
  argv(request: HarnessRequest): string[];
  parse(line: string): HarnessEvent | HarnessEvent[] | undefined;
};

function normalize(parsed: HarnessEvent | HarnessEvent[] | undefined): HarnessEvent[] {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  return [parsed];
}

function terminal(event: HarnessEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed";
}

export function processHarness(options: HarnessProcessOptions): HarnessAdapter {
  return {
    name: options.name,
    async start(request: HarnessRequest): Promise<HarnessRun> {
      const child = Bun.spawn(options.argv(request), {
        cwd: request.cwd,
        env: { ...globalThis.process.env, ...request.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (child.stderr) void new Response(child.stderr).text();
      let cancelled = false;
      return {
        events: (async function* () {
          const reader = child.stdout.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let ended = false;
          let terminalSeen = false;
          try {
            while (!ended) {
              const chunk = await reader.read();
              if (chunk.done) {
                ended = true;
              } else {
                buffer += decoder.decode(chunk.value, { stream: true });
              }
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                for (const event of normalize(options.parse(line.trim()))) {
                  terminalSeen ||= terminal(event);
                  yield event;
                }
              }
            }
            buffer += decoder.decode();
            if (buffer.trim()) {
              for (const event of normalize(options.parse(buffer.trim()))) {
                terminalSeen ||= terminal(event);
                yield event;
              }
            }
          } finally {
            reader.releaseLock();
          }
          const exitCode = await child.exited;
          if (!cancelled && !terminalSeen && exitCode !== 0) {
            yield { type: "run.failed", reason: `harness exited with code ${exitCode}` };
          }
        })(),
        cancel() {
          cancelled = true;
          child.kill();
        },
      };
    },
  };
}
