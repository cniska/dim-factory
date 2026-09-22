import { codexArgv, codexHarness, parseCodexHarnessEvent } from "./codex-harness";
import type { HarnessEvent, HarnessRequest } from "./harness";
import type { HarnessName } from "./harness-name";
import { runHarness } from "./harness-runner";

export type { HarnessName } from "./harness-name";

export type HarnessCommandRequest = HarnessRequest & { harness: HarnessName };

export type HarnessCommandResult = {
  exitCode: number;
  output: string;
  events: HarnessEvent[];
};

export type HarnessStarted = (providerSessionId: string) => void;

export function harnessArgv(request: HarnessCommandRequest): string[] {
  if (request.harness === "codex") return codexArgv("codex", request);
  throw new Error(`unsupported harness ${request.harness}`);
}

export function runHarnessCommand(request: HarnessCommandRequest): HarnessCommandResult {
  const child = Bun.spawnSync(harnessArgv(request), {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const events: HarnessEvent[] = [];
  for (const line of child.stdout.toString().split("\n")) {
    const parsed = parseCodexHarnessEvent(line.trim());
    if (Array.isArray(parsed)) events.push(...parsed);
    else if (parsed) events.push(parsed);
  }
  return {
    exitCode: child.exitCode ?? 1,
    output: events
      .filter((event): event is Extract<HarnessEvent, { type: "message" }> => event.type === "message")
      .map((event) => event.text)
      .join("\n"),
    events,
  };
}

export async function runHarnessCommandLive(
  request: HarnessCommandRequest,
  onStarted: HarnessStarted,
): Promise<HarnessCommandResult> {
  if (request.harness !== "codex") throw new Error(`unsupported harness ${request.harness}`);
  const result = await runHarness(codexHarness(), request, {
    timeoutMs: 10 * 60 * 1000,
    onEvent: (event) => {
      if (event.type === "run.started" && event.providerSessionId) onStarted(event.providerSessionId);
    },
  });
  const output = result.events
    .filter((event): event is Extract<HarnessEvent, { type: "message" }> => event.type === "message")
    .map((event) => event.text)
    .join("\n");
  return { exitCode: result.outcome === "completed" ? 0 : 1, output, events: result.events };
}
