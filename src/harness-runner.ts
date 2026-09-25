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
  /** How long the adapter may go without reporting an event: a working run has no bound on its
   *  length, and only silence says a worker is stuck. */
  timeoutMs: number;
  onEvent?: (event: HarnessEvent) => void;
};

/** Times one run, whether its adapter started it or resumed it. */
export async function runHarness(run: HarnessRun, options: HarnessRunnerOptions): Promise<HarnessRunResult> {
  const events: HarnessEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let expire: () => void = () => undefined;
  const arm = (): void => {
    if (timedOut) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(expire, options.timeoutMs);
  };
  const consume = (async (): Promise<HarnessRunResult> => {
    for await (const event of run.events) {
      arm();
      events.push(event);
      options.onEvent?.(event);
      if (event.type === "run.completed") return { outcome: "completed", events };
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
    return { outcome: "failed", events, reason: "harness stream ended without a terminal event" };
  })();
  const timeout = new Promise<HarnessRunResult>((resolve) => {
    expire = () => {
      timedOut = true;
      run.cancel();
      resolve({ outcome: "timed_out", events, reason: "harness timed out" });
    };
    arm();
  });
  let result: HarnessRunResult;
  try {
    result = await Promise.race([consume, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut) void consume.catch(() => undefined);
  // A failed run may still be working, and a refused one still spending; a completed run is
  // left to exit on its own, since the harness records its session after the answer.
  if (result.outcome === "failed") run.cancel();
  return result;
}
