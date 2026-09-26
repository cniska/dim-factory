import type { HarnessAdapter, HarnessEvent, HarnessRequest, HarnessRun } from "./harness";

export type ScriptedAnswer = { output: string } | { failure: string };

export function scriptedHarness(answer: (request: HarnessRequest) => ScriptedAnswer): HarnessAdapter {
  const run = async (providerSessionId: string, request: HarnessRequest): Promise<HarnessRun> => ({
    pid: process.pid,
    events: (async function* (): AsyncGenerator<HarnessEvent> {
      yield { type: "run.started", providerSessionId };
      yield { type: "turn.started" };
      const answered = answer(request);
      if ("failure" in answered) {
        yield { type: "run.failed", reason: answered.failure };
        return;
      }
      yield { type: "message", role: "assistant", text: answered.output };
      yield { type: "run.completed", output: answered.output };
    })(),
    cancel() {},
  });
  return {
    start: (request) => run(`scripted-${crypto.randomUUID()}`, request),
    resume: run,
  };
}
