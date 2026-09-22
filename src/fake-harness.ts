import type { HarnessAdapter, HarnessEvent, HarnessRequest, HarnessRun } from "./harness";

export type FakeHarnessScenario = "success" | "findings" | "crash" | "hang" | "bootstrap-failure";

type Scenario = {
  events: HarnessEvent[];
  completes: boolean;
};

function scenario(name: FakeHarnessScenario): Scenario {
  const started: HarnessEvent[] = [
    { type: "run.started", providerSessionId: "fake-session" },
    { type: "turn.started" },
  ];
  if (name === "success") {
    return {
      events: [
        ...started,
        { type: "message", role: "assistant", text: "completed" },
        { type: "run.completed", output: "completed" },
      ],
      completes: true,
    };
  }
  if (name === "findings") {
    return {
      events: [
        ...started,
        { type: "message", role: "assistant", text: "finding: the result needs another pass" },
        { type: "run.completed", output: "finding: the result needs another pass" },
      ],
      completes: true,
    };
  }
  if (name === "crash") {
    return { events: [...started, { type: "run.failed", reason: "fake process crashed" }], completes: true };
  }
  if (name === "bootstrap-failure") {
    return {
      events: [{ type: "run.failed", reason: "worker bootstrap failed" }],
      completes: true,
    };
  }
  return { events: started, completes: false };
}

export function fakeHarness(scenarioName: FakeHarnessScenario): HarnessAdapter {
  return {
    name: "fake",
    async start(_request: HarnessRequest): Promise<HarnessRun> {
      const plan = scenario(scenarioName);
      let cancelled = false;
      let release: (() => void) | undefined;
      const cancellation = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        events: (async function* () {
          for (const event of plan.events) {
            if (cancelled) return;
            yield event;
          }
          if (!plan.completes) await cancellation;
        })(),
        cancel() {
          cancelled = true;
          release?.();
        },
      };
    },
  };
}
