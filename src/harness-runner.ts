import type { HarnessAdapter, HarnessEvent, HarnessRequest } from "./harness";

export type HarnessRunResult =
  | { outcome: "completed"; events: HarnessEvent[]; output?: string }
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

export async function runHarness(
  adapter: HarnessAdapter,
  request: HarnessRequest,
  options: HarnessRunnerOptions,
): Promise<HarnessRunResult> {
  const run = await adapter.start(request);
  const events: HarnessEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const consume = (async (): Promise<HarnessRunResult> => {
    for await (const event of run.events) {
      events.push(event);
      options.onEvent?.(event);
      if (event.type === "run.completed") return { outcome: "completed", events, output: event.output };
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
    timer = setTimeout(() => {
      timedOut = true;
      run.cancel();
      resolve({ outcome: "timed_out", events, reason: "harness timed out" });
    }, options.timeoutMs);
  });
  const result = await Promise.race([consume, timeout]);
  if (timer) clearTimeout(timer);
  if (timedOut) void consume.catch(() => undefined);
  return result;
}
