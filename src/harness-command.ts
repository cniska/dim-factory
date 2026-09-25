import { claudeProcess } from "./claude-harness";
import { codexProcess } from "./codex-harness";
import { WORKER_NAME_VAR, WORKER_SESSION_VAR, WORKER_TOKEN_VAR } from "./factory-worker";
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
import { ASSIGNMENT_ID_VAR, ASSIGNMENT_TOKEN_VAR } from "./worker-assignment";

export type HarnessCommandRequest = HarnessRequest & { harness: HarnessName };

export type HarnessCommandResult = {
  exitCode: number;
  /** The run's answer when it completed, and otherwise the worker's last word, which explains the failure. */
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
  // Labelled so the worker's last word is not read as the cause: a run the runner stopped ends on
  // whatever the worker happened to be saying.
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

export type HarnessStarted = (providerSessionId: string) => void;

/**
 * The process spawning a worker is the operator's. A worker's factory identity is whatever
 * its request carries and nothing else, or a first turn — whose request carries only an
 * assignment — would inherit the operator's token and could act as the operator.
 */
const FACTORY_IDENTITY_VARS = [
  WORKER_NAME_VAR,
  WORKER_TOKEN_VAR,
  WORKER_SESSION_VAR,
  ASSIGNMENT_ID_VAR,
  ASSIGNMENT_TOKEN_VAR,
];

/**
 * An operator run from inside Claude Code exports its own session to every child, whatever
 * harness the child runs: its id, its messaging socket and token, and whether a person is
 * attending it. A worker holding those could post into the operator's unsandboxed session and
 * have its hooks filed under it. An operator run from inside Codex exports its thread id, which
 * `dim operator` reads to pick a session, so a worker holding it would resolve as the operator. `CLAUDE_CODE_OAUTH_TOKEN` is a
 * subscription login, as `claude setup-token` issues it on a machine without a keychain, so it
 * is kept.
 */
const OPERATOR_SESSION_VARS = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CODEX_THREAD_ID"];
const SUBSCRIPTION_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

function operatorSessionVar(name: string): boolean {
  if (name === SUBSCRIPTION_TOKEN_VAR) return false;
  return name.startsWith("CLAUDE_CODE_") || OPERATOR_SESSION_VARS.includes(name);
}

function workerEnvironment(spec: HarnessProcess, request: HarnessRequest): ProcessEnvironment {
  const inherited: ProcessEnvironment = { ...globalThis.process.env };
  for (const name of FACTORY_IDENTITY_VARS) delete inherited[name];
  Object.assign(inherited, request.env);
  for (const name of Object.keys(inherited)) if (operatorSessionVar(name)) delete inherited[name];
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
      if (event.type === "run.started" && event.providerSessionId) onStarted(event.providerSessionId);
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
