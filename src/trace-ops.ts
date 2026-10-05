import { isRefusal } from "./coded-error";
import { type Env, tracePath } from "./paths";
import { type StepOutcome, type Trace, TraceLine } from "./trace-contract";
import { appendLine, readFrom, sizeOf } from "./trace-effects";

const FOLLOW_POLL_MS = 100;

const NEWLINE = 0x0a;

function outcomeOf(error: unknown): StepOutcome {
  if (isRefusal(error)) return { kind: "refused", code: error.code };
  return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
}

export function traceOf(order: string, env: Env): Trace {
  const path = tracePath(env);
  let seq = 0;
  const write = (fields: Readonly<Record<string, unknown>>) => {
    seq += 1;
    appendLine(
      path,
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, order, seq, ...fields }),
    );
  };
  const started = (step: string, start: object) => {
    write({ step, phase: "started", ...start });
    return performance.now();
  };
  const ended = (step: string, since: number, outcome: StepOutcome, result: object = {}) =>
    write({ step, phase: "ended", ms: Math.round(performance.now() - since), outcome, ...result });
  return {
    step(name, start, perform, ...[result]) {
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
    async stepAsync(name, start, perform, ...[result]) {
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

export async function followTrace(
  order: string,
  env: Env,
  live: () => boolean,
  print: (line: string) => void,
): Promise<void> {
  const path = tracePath(env);
  let offset = 0;
  let partial = Buffer.alloc(0);
  for (;;) {
    const alive = live();
    if (sizeOf(path) < offset) {
      offset = 0;
      partial = Buffer.alloc(0);
    }
    const read = readFrom(path, offset);
    offset += read.length;
    if (read.length === 0 && !alive) return;
    const pending = Buffer.concat([partial, read]);
    const end = pending.lastIndexOf(NEWLINE);
    partial = pending.subarray(end + 1);
    const lines = end < 0 ? [] : pending.subarray(0, end).toString("utf8").split("\n");
    for (const line of lines) if (TraceLine.parse(JSON.parse(line)).order === order) print(line);
    await Bun.sleep(FOLLOW_POLL_MS);
  }
}
