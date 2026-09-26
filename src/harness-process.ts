import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, HarnessEvent, HarnessRequest, HarnessRun } from "./harness";

export type ProcessEnvironment = Record<string, string | undefined>;

export type HarnessProcess = {
  command: string;
  args(request: HarnessRequest): string[];
  resumeArgs(providerSessionId: string, request: HarnessRequest): string[];
  parser(): HarnessLineParser;
  environment?(inherited: ProcessEnvironment): ProcessEnvironment;
};

export type HarnessLineParser = (line: string) => HarnessEvent | HarnessEvent[] | undefined;

const OUTPUT_POLL_INTERVAL_MS = 10;

export function commandLine(spec: HarnessProcess, request: HarnessRequest): string[] {
  return [spec.command, ...spec.args(request)];
}

export function resumeCommandLine(
  spec: HarnessProcess,
  providerSessionId: string,
  request: HarnessRequest,
): string[] {
  return [spec.command, ...spec.resumeArgs(providerSessionId, request)];
}

export function parseLines(parse: HarnessLineParser, lines: string[]): HarnessEvent[] {
  return lines.flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const parsed = parse(trimmed);
    if (!parsed) return [];
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

function terminal(event: HarnessEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed";
}

export function processHarness(
  spec: HarnessProcess,
  environment: (request: HarnessRequest) => ProcessEnvironment,
): HarnessAdapter {
  const run = async (argv: string[], request: HarnessRequest): Promise<HarnessRun> => {
    const directory = mkdtempSync(join(tmpdir(), "dim-harness-"));
    const stdoutPath = join(directory, "stdout");
    const stderrPath = join(directory, "stderr");
    let stdout: number | undefined;
    let stderr: number | undefined;
    let child: ReturnType<typeof Bun.spawn>;
    try {
      stdout = openSync(stdoutPath, "w+");
      stderr = openSync(stderrPath, "w+");
      child = Bun.spawn(argv, {
        cwd: request.cwd,
        env: environment(request),
        stdin: "ignore",
        stdout,
        stderr,
      });
    } catch (error) {
      if (stdout !== undefined) closeSync(stdout);
      if (stderr !== undefined) closeSync(stderr);
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    const parse = spec.parser();
    let cancelled = false;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      closeSync(stdout);
      closeSync(stderr);
      rmSync(directory, { recursive: true, force: true });
    };
    return {
      pid: child.pid,
      events: (async function* () {
        const stdoutDecoder = new TextDecoder();
        const stderrDecoder = new TextDecoder();
        let stdoutCursor = 0;
        let stderrCursor = 0;
        let stdoutBuffer = "";
        let stderrOutput = "";
        let terminalSeen = false;
        const drain = (fd: number, decoder: TextDecoder, cursor: number): [string, number] => {
          const size = fstatSync(fd).size;
          const bytes = Buffer.alloc(size - cursor);
          let offset = 0;
          while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, cursor + offset);
            if (count === 0) break;
            offset += count;
          }
          return [decoder.decode(bytes.subarray(0, offset), { stream: true }), cursor + offset];
        };
        const events = (text: string, final = false): HarnessEvent[] => {
          stdoutBuffer += text;
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? "";
          if (final && stdoutBuffer.trim()) {
            lines.push(stdoutBuffer);
            stdoutBuffer = "";
          }
          return parseLines(parse, lines);
        };
        const exited = child.exited.then((code) => ({ type: "exit" as const, code }));
        try {
          while (true) {
            const [stdoutText, nextStdout] = drain(stdout, stdoutDecoder, stdoutCursor);
            stdoutCursor = nextStdout;
            const [stderrText, nextStderr] = drain(stderr, stderrDecoder, stderrCursor);
            stderrCursor = nextStderr;
            stderrOutput += stderrText;
            for (const event of events(stdoutText)) {
              terminalSeen ||= terminal(event);
              yield event;
            }

            const outcome = await Promise.race([
              exited,
              new Promise<{ type: "poll" }>((resolve) => {
                setTimeout(() => resolve({ type: "poll" }), OUTPUT_POLL_INTERVAL_MS);
              }),
            ]);
            if (outcome.type === "poll") continue;

            const [lastStdout] = drain(stdout, stdoutDecoder, stdoutCursor);
            const [lastStderr] = drain(stderr, stderrDecoder, stderrCursor);
            stderrOutput += lastStderr + stderrDecoder.decode();
            const remaining = events(lastStdout + stdoutDecoder.decode(), true);
            for (const event of remaining) {
              terminalSeen ||= terminal(event);
              yield event;
            }
            if (!cancelled && !terminalSeen) {
              const errorOutput = stderrOutput.trim();
              yield {
                type: "run.failed",
                reason:
                  outcome.code === 0
                    ? "harness exited without a terminal event"
                    : `harness exited with code ${outcome.code}`,
                exitCode: outcome.code,
                ...(errorOutput ? { stderr: errorOutput } : {}),
                termination: "exited",
              };
            }
            return;
          }
        } finally {
          close();
        }
      })(),
      cancel() {
        cancelled = true;
        child.kill();
      },
    };
  };
  return {
    start: (request) => run(commandLine(spec, request), request),
    resume: (providerSessionId, request) => run(resumeCommandLine(spec, providerSessionId, request), request),
  };
}
