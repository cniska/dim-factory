import { claudeProcess } from "./claude-harness";
import { codexProcess } from "./codex-harness";
import type { HarnessAdapter, HarnessEvent, HarnessRequest, HarnessRun } from "./harness";
import type { HarnessName } from "./harness-name";
import {
  commandLine,
  type HarnessProcess,
  type ProcessEnvironment,
  parseLines,
  processHarness,
} from "./harness-process";
import { runHarness } from "./harness-runner";
import { stationEnvironment } from "./station-environment";

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
  const lastWord = output?.trim() ? `its last message: ${output.trim()}` : undefined;
  const details = [harnessReason, lastWord].filter((value): value is string => Boolean(value));
  return details.length === 0 ? message : `${message}: ${details.join("; ")}`;
}

const HARNESS_PROCESSES: Record<HarnessName, HarnessProcess> = {
  codex: codexProcess,
  claude: claudeProcess,
};

function workerOutput(events: HarnessEvent[]): string {
  const completed = events.find(
    (event): event is Extract<HarnessEvent, { type: "run.completed" }> => event.type === "run.completed",
  );
  if (completed) return completed.output ?? "";
  return (
    events
      .filter((event): event is Extract<HarnessEvent, { type: "message" }> => event.type === "message")
      .at(-1)?.text ?? ""
  );
}

export type HarnessStarted = (providerSessionId: string, pid: number) => void;

function workerEnvironment(spec: HarnessProcess, request: HarnessRequest): ProcessEnvironment {
  const inherited = stationEnvironment(request.env);
  return spec.environment ? spec.environment(inherited) : inherited;
}

function harnessAdapter(harness: HarnessName): HarnessAdapter {
  const spec = HARNESS_PROCESSES[harness];
  return processHarness(spec, (request) => workerEnvironment(spec, request));
}

export function harnessCommand(harness: HarnessName): string {
  return HARNESS_PROCESSES[harness].command;
}

export function harnessArgv(request: HarnessCommandRequest): string[] {
  return commandLine(HARNESS_PROCESSES[request.harness], request);
}

export function runHarnessCommand(request: HarnessCommandRequest): HarnessCommandResult {
  const spec = HARNESS_PROCESSES[request.harness];
  const child = Bun.spawnSync(commandLine(spec, request), {
    cwd: request.cwd,
    env: workerEnvironment(spec, request),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const events = parseLines(spec.parser(), child.stdout.toString().split("\n"));
  const failed = events.find(
    (event): event is Extract<HarnessEvent, { type: "run.failed" }> => event.type === "run.failed",
  );
  return {
    exitCode: failed ? 1 : (child.exitCode ?? 1),
    output: workerOutput(events),
    events,
    ...(failed ? { failureReason: failed.reason } : {}),
  };
}

const WORKER_RUN_TIMEOUT_MS = 10 * 60 * 1000;

type WorkerRunOptions = { timeoutMs?: number };

export async function runHarnessCommandLive(
  request: HarnessCommandRequest,
  onStarted: HarnessStarted,
  adapter: HarnessAdapter = harnessAdapter(request.harness),
  options: WorkerRunOptions = {},
): Promise<HarnessCommandResult> {
  return runHarnessSessionLive(await adapter.start(request), onStarted, options);
}

export async function runHarnessCommandResumeLive(
  request: HarnessCommandRequest,
  providerSessionId: string,
  onStarted: HarnessStarted,
  adapter: HarnessAdapter = harnessAdapter(request.harness),
  options: WorkerRunOptions = {},
): Promise<HarnessCommandResult> {
  return runHarnessSessionLive(await adapter.resume(providerSessionId, request), onStarted, options);
}

async function runHarnessSessionLive(
  run: HarnessRun,
  onStarted: HarnessStarted,
  options: WorkerRunOptions,
): Promise<HarnessCommandResult> {
  const timeoutMs = options.timeoutMs ?? WORKER_RUN_TIMEOUT_MS;
  const result = await runHarness(run, {
    timeoutMs,
    onEvent: (event) => {
      if (event.type === "run.started" && event.providerSessionId)
        onStarted(event.providerSessionId, run.pid);
    },
  });
  const output = workerOutput(result.events);
  const failureReason =
    result.outcome === "failed"
      ? [result.reason, result.stderr ? `stderr: ${result.stderr}` : undefined]
          .filter((detail): detail is string => Boolean(detail))
          .join("; ")
      : result.outcome === "timed_out"
        ? `harness went ${timeoutMs / 1000}s without an event and was stopped`
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
