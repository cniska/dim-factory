import type { HarnessAdapter, HarnessEvent, HarnessRequest, HarnessRun } from "./harness";

type HarnessProcessOptions = {
  name: string;
  argv(request: HarnessRequest): string[];
  resumeArgv(providerSessionId: string, request: HarnessRequest): string[];
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
  const run = async (argv: string[], request: HarnessRequest): Promise<HarnessRun> => {
    const child = Bun.spawn(argv, {
      cwd: request.cwd,
      env: { ...globalThis.process.env, ...request.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
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
        if (!cancelled && !terminalSeen) {
          const errorOutput = (await stderr).trim();
          yield {
            type: "run.failed",
            reason:
              exitCode === 0
                ? "harness exited without a terminal event"
                : `harness exited with code ${exitCode}`,
            exitCode,
            ...(errorOutput ? { stderr: errorOutput } : {}),
            termination: "exited",
          };
        }
      })(),
      cancel() {
        cancelled = true;
        child.kill();
      },
    };
  };
  return {
    name: options.name,
    start: (request) => run(options.argv(request), request),
    resume: (providerSessionId, request) => run(options.resumeArgv(providerSessionId, request), request),
  };
}
