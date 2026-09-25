import { gitMetadataDirs } from "./git-metadata-dirs";
import type { HarnessEvent, HarnessRequest } from "./harness";
import type { HarnessLineParser, HarnessProcess, ProcessEnvironment } from "./harness-process";
import { dataDir } from "./paths";

type CodexEvent = {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
  };
  error?: { message?: string };
};

function itemName(item: CodexEvent["item"]): string {
  return item?.type ?? "codex item";
}

function itemEvents(event: CodexEvent): HarnessEvent[] {
  const item = event.item;
  if (!item) return [];
  const name = itemName(item);
  const toolId = item.id;
  if (event.type === "item.started") return [{ type: "tool.started", name, toolId }];
  if (event.type === "item.updated") {
    const text = item.aggregated_output ?? item.text;
    return text ? [{ type: "tool.output", name, text, toolId }] : [];
  }
  if (event.type !== "item.completed") return [];
  const output = item.aggregated_output ?? item.text;
  return [
    ...(output ? [{ type: "tool.output", name, text: output, toolId } as const] : []),
    { type: "tool.completed", name, exitCode: item.exit_code, toolId },
  ];
}

/** Stateful because Codex states no answer of its own: a run's answer is its last agent message. */
function codexEventParser(): HarnessLineParser {
  let answer: string | undefined;
  return (line) => {
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      return { type: "diagnostic", level: "error", message: "Codex emitted invalid JSON" };
    }
    if (event.type === "thread.started") return { type: "run.started", providerSessionId: event.thread_id };
    if (event.type === "turn.started") return { type: "turn.started" };
    if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
      answer = event.item.text;
      return { type: "message", role: "assistant", text: event.item.text };
    }
    const items = itemEvents(event);
    if (items.length > 0) return items;
    if (event.type === "turn.completed") {
      return answer === undefined ? { type: "run.completed" } : { type: "run.completed", output: answer };
    }
    if (event.type === "turn.failed") {
      return { type: "run.failed", reason: event.error?.message ?? "Codex turn failed" };
    }
    if (event.type === "error") return { type: "run.failed", reason: event.error?.message ?? "Codex failed" };
    return undefined;
  };
}

function codexSandboxArgs(request: HarnessRequest): string[] {
  const sandbox = request.capabilities.includes("edit-files") ? "workspace-write" : "read-only";
  const gitDirs = gitMetadataDirs(request.cwd);
  return [
    "-s",
    sandbox,
    "--add-dir",
    dataDir(request.env),
    ...gitDirs.flatMap((gitDir) => ["--add-dir", gitDir]),
  ];
}

/** An API-key login stored with `codex login --with-api-key` survives any environment filter. */
const SUBSCRIPTION_LOGIN = ["-c", 'forced_login_method="chatgpt"'];

export function codexArgs(request: HarnessRequest): string[] {
  return [
    ...SUBSCRIPTION_LOGIN,
    "exec",
    "--json",
    ...(request.outputSchema ? ["--output-schema", request.outputSchema] : []),
    ...codexSandboxArgs(request),
    "-C",
    request.cwd,
    "-m",
    request.model,
    request.brief,
  ];
}

export function codexResumeArgs(providerSessionId: string, request: HarnessRequest): string[] {
  return [
    ...SUBSCRIPTION_LOGIN,
    ...codexSandboxArgs(request),
    "exec",
    "resume",
    "--json",
    ...(request.outputSchema ? ["--output-schema", request.outputSchema] : []),
    providerSessionId,
    "-m",
    request.model,
    request.brief,
  ];
}

/** Codex bills an API key per token, where the worker should run on the operator's signed-in plan. */
const PER_TOKEN_VARS = ["CODEX_API_KEY", "OPENAI_API_KEY"];

function withoutPerTokenCredentials(inherited: ProcessEnvironment): ProcessEnvironment {
  return Object.fromEntries(Object.entries(inherited).filter(([name]) => !PER_TOKEN_VARS.includes(name)));
}

export const codexProcess: HarnessProcess = {
  command: "codex",
  args: codexArgs,
  resumeArgs: codexResumeArgs,
  parser: codexEventParser,
  environment: withoutPerTokenCredentials,
};
