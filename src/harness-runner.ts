import type { HarnessEvent, HarnessRun } from "./harness";

export type HarnessRunResult =
  | { outcome: "completed"; events: HarnessEvent[] }
  | {
      outcome: "failed";
      events: HarnessEvent[];
      reason: string;
      exitCode?: number;
      stderr?: string;
      termination?: "exited" | "cancelled";
    }
  | { outcome: "timed_out"; events: HarnessEvent[]; reason: string };

export type HarnessRunnerOptions = {
  timeoutMs: number;
  onEvent?: (event: HarnessEvent) => void;
};

const SECOND_START = "harness fault: the worker started a second run before answering";

function beginsTurn(event: HarnessEvent): boolean {
  return (
    event.type === "run.started" ||
    event.type === "turn.started" ||
    event.type === "message" ||
    event.type.startsWith("tool.")
  );
}

export async function runHarness(run: HarnessRun, options: HarnessRunnerOptions): Promise<HarnessRunResult> {
  const events: HarnessEvent[] = [];
  let answer: HarnessRunResult | undefined;
  let stopped = false;
  const stopAfterAnswer = (why: string): void => {
    stopped = true;
    run.cancel();
    events.push({
      type: "diagnostic",
      level: "warning",
      message: `stopped the worker after its answer: ${why}`,
    });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let expire: () => void = () => undefined;
  const arm = (): void => {
    if (timedOut) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(expire, options.timeoutMs);
  };
  const consume = (async (): Promise<HarnessRunResult> => {
    let started = false;
    for await (const event of run.events) {
      arm();
      if (answer) {
        if (!stopped && beginsTurn(event)) stopAfterAnswer(`it began another turn (${event.type})`);
        continue;
      }
      if (event.type === "run.started") {
        if (started) return { outcome: "failed", events, reason: SECOND_START };
        started = true;
      }
      events.push(event);
      options.onEvent?.(event);
      if (event.type === "run.completed") {
        answer = { outcome: "completed", events };
        continue;
      }
      if (event.type === "run.failed") {
        return {
          outcome: "failed",
          events,
          reason: event.reason,
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
          ...(event.stderr === undefined ? {} : { stderr: event.stderr }),
          ...(event.termination === undefined ? {} : { termination: event.termination }),
        };
      }
    }
    return answer ?? { outcome: "failed", events, reason: "harness stream ended without a terminal event" };
  })();
  const timeout = new Promise<HarnessRunResult>((resolve) => {
    expire = () => {
      timedOut = true;
      if (answer) {
        stopAfterAnswer(`it went ${options.timeoutMs / 1000}s without an event and did not exit`);
        resolve(answer);
        return;
      }
      run.cancel();
      resolve({ outcome: "timed_out", events, reason: "harness timed out" });
    };
    arm();
  });
  let result: HarnessRunResult;
  try {
    result = await Promise.race([consume, timeout]);
  } catch (error) {
    run.cancel();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut) void consume.catch(() => undefined);
  if (result.outcome === "failed") run.cancel();
  return result;
}
