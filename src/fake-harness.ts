import type { HarnessAdapter, HarnessEvent, HarnessRun } from "./harness";
import { REVIEW_DIMENSIONS } from "./review-artifact";

export type FakeHarnessScenario =
  | "success"
  | "plan"
  | "review"
  | "findings"
  | "crash"
  | "hang"
  | "bootstrap-failure"
  | "turn-after-answer"
  | "second-start";

type Scenario = {
  events: HarnessEvent[];
  completes: boolean;
};

export type FakeHarness = HarnessAdapter & {
  /** How many times the runner has cancelled one of this adapter's runs. */
  cancels(): number;
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
  if (name === "plan") {
    const output = JSON.stringify({
      body: "## Outcome\n\nBuild the requested result.",
      slices: [{ title: "Complete the request", outcome: "The requested result is verified." }],
    });
    return {
      events: [
        ...started,
        { type: "message", role: "assistant", text: output },
        { type: "run.completed", output },
      ],
      completes: true,
    };
  }
  if (name === "review") {
    const output = JSON.stringify({
      verdict: "The change is sound.",
      findings: [],
      rulings: [],
      conformance: [],
      coverage: REVIEW_DIMENSIONS.map((dimension) => ({ dimension, status: "clean", reason: null })),
      set_aside: [],
      unverified: [],
      observations: [],
    });
    return {
      events: [
        ...started,
        { type: "message", role: "assistant", text: output },
        { type: "run.completed", output },
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
  if (name === "turn-after-answer") {
    return {
      events: [
        ...started,
        { type: "run.completed", output: "completed" },
        ...started,
        { type: "message", role: "assistant", text: "a background check reported" },
      ],
      completes: false,
    };
  }
  if (name === "second-start") {
    return { events: [...started, ...started], completes: false };
  }
  return { events: started, completes: false };
}

export function fakeHarness(scenarioName: FakeHarnessScenario): FakeHarness {
  let cancels = 0;
  const run = async (): Promise<HarnessRun> => {
    const plan = scenario(scenarioName);
    let cancelled = false;
    let release: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      pid: process.pid,
      events: (async function* () {
        for (const event of plan.events) {
          if (cancelled) return;
          yield event;
        }
        if (!plan.completes) await cancellation;
      })(),
      cancel() {
        cancels += 1;
        cancelled = true;
        release?.();
      },
    };
  };
  return {
    start: run,
    resume: run,
    cancels: () => cancels,
  };
}
