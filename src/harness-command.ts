import { codexArgv, codexHarness, parseCodexHarnessEvent } from "./codex-harness";
import type { HarnessAdapter, HarnessEvent, HarnessRequest, HarnessRun } from "./harness";
import type { HarnessName } from "./harness-name";
import { runHarness } from "./harness-runner";

export type { HarnessName } from "./harness-name";

export type HarnessCommandRequest = HarnessRequest & { harness: HarnessName };

export type HarnessCommandResult = {
  exitCode: number;
  output: string;
  events: HarnessEvent[];
  failureReason?: string;
  harnessExitCode?: number;
  stderr?: string;
  termination?: "exited" | "cancelled";
};

export function workerFailureReason(
  message: string,
  output: string | undefined,
  harnessReason: string | undefined,
): string {
  const details = [harnessReason, output?.trim()].filter((value): value is string => Boolean(value));
  return details.length === 0 ? message : `${message}: ${details.join("; ")}`;
}

function finalMessage(events: HarnessEvent[]): string {
  return (
    events
      .filter((event): event is Extract<HarnessEvent, { type: "message" }> => event.type === "message")
      .at(-1)?.text ?? ""
  );
}

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
    output: finalMessage(events),
    events,
  };
}

export async function runHarnessCommandLive(
  request: HarnessCommandRequest,
  onStarted: HarnessStarted,
  adapter: HarnessAdapter = codexHarness(),
): Promise<HarnessCommandResult> {
  return runHarnessSessionLive(request, onStarted, () => adapter.start(request));
}

export async function runHarnessCommandResumeLive(
  request: HarnessCommandRequest,
  providerSessionId: string,
  onStarted: HarnessStarted,
  adapter: HarnessAdapter = codexHarness(),
): Promise<HarnessCommandResult> {
  return runHarnessSessionLive(request, onStarted, () => adapter.resume(providerSessionId, request));
}

async function runHarnessSessionLive(
  request: HarnessCommandRequest,
  onStarted: HarnessStarted,
  start: () => Promise<HarnessRun>,
): Promise<HarnessCommandResult> {
  if (request.harness !== "codex") throw new Error(`unsupported harness ${request.harness}`);
  const result = await runHarness({ name: "selected", start, resume: () => start() }, request, {
    timeoutMs: 10 * 60 * 1000,
    onEvent: (event) => {
      if (event.type === "run.started" && event.providerSessionId) onStarted(event.providerSessionId);
    },
  });
  const output = finalMessage(result.events);
  const failureReason =
    result.outcome === "failed"
      ? [result.reason, result.stderr ? `stderr: ${result.stderr}` : undefined]
          .filter((detail): detail is string => Boolean(detail))
          .join("; ")
      : undefined;
  return {
    exitCode: result.outcome === "completed" ? 0 : 1,
    output,
    events: result.events,
    ...(failureReason ? { failureReason } : {}),
    ...(result.outcome === "failed" && result.exitCode !== undefined
      ? { harnessExitCode: result.exitCode }
      : {}),
    ...(result.outcome === "failed" && result.stderr ? { stderr: result.stderr } : {}),
    ...(result.outcome === "failed" && result.termination ? { termination: result.termination } : {}),
  };
}
