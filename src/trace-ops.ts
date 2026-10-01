import { CodedError } from "./coded-error";
import { type Env, tracePath } from "./paths";
import type { StepOutcome, StepResult, Trace } from "./trace-contract";
import { appendLine, empty, readFrom, sizeOf } from "./trace-effects";

const FOLLOW_POLL_MS = 100;

function outcomeOf(error: unknown): StepOutcome {
  if (error instanceof CodedError) return { kind: "refused", code: error.code };
  return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
}

export function traceOf(order: string, cause: number, env: Env): Trace {
  const path = tracePath(env);
  let seq = 0;
  const write = (fields: Readonly<Record<string, unknown>>) => {
    seq += 1;
    appendLine(
      path,
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, order, cause, seq, ...fields }),
    );
  };
  const started = (step: string, start: object) => {
    write({ step, phase: "started", ...start });
    return performance.now();
  };
  const ended = (step: string, since: number, outcome: StepOutcome, result: StepResult = {}) =>
    write({ step, phase: "ended", ms: Math.round(performance.now() - since), outcome, ...result });
  return {
    order,
    cause,
    step(name, start, perform, result) {
      const since = started(name, start);
      let done: ReturnType<typeof perform>;
      try {
        done = perform();
      } catch (error) {
        ended(name, since, outcomeOf(error));
        throw error;
      }
      ended(name, since, { kind: "ok" }, result?.(done));
      return done;
    },
    async stepAsync(name, start, perform, result) {
      const since = started(name, start);
      let done: Awaited<ReturnType<typeof perform>>;
      try {
        done = await perform();
      } catch (error) {
        ended(name, since, outcomeOf(error));
        throw error;
      }
      ended(name, since, { kind: "ok" }, result?.(done));
      return done;
    },
  };
}

export async function followTrace(order: string, env: Env, print: (line: string) => void): Promise<never> {
  const path = tracePath(env);
  let offset = 0;
  let partial = "";
  for (;;) {
    if (sizeOf(path) < offset) {
      offset = 0;
      partial = "";
    }
    const text = readFrom(path, offset);
    offset += Buffer.byteLength(text);
    const lines = `${partial}${text}`.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) if (JSON.parse(line).order === order) print(line);
    await Bun.sleep(FOLLOW_POLL_MS);
  }
}

export function clearTrace(env: Env): void {
  empty(tracePath(env));
}
