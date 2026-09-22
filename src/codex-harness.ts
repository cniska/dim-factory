import type { HarnessAdapter, HarnessEvent, HarnessRequest } from "./harness";
import { processHarness } from "./harness-process";
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

export function parseCodexHarnessEvent(line: string): HarnessEvent | HarnessEvent[] | undefined {
  let event: CodexEvent;
  try {
    event = JSON.parse(line) as CodexEvent;
  } catch {
    return { type: "diagnostic", level: "error", message: "Codex emitted invalid JSON" };
  }
  if (event.type === "thread.started") return { type: "run.started", providerSessionId: event.thread_id };
  if (event.type === "turn.started") return { type: "turn.started" };
  if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
    return { type: "message", role: "assistant", text: event.item.text };
  }
  const items = itemEvents(event);
  if (items.length > 0) return items;
  if (event.type === "turn.completed") return { type: "run.completed" };
  if (event.type === "turn.failed") {
    return { type: "run.failed", reason: event.error?.message ?? "Codex turn failed" };
  }
  if (event.type === "error") return { type: "run.failed", reason: event.error?.message ?? "Codex failed" };
  return undefined;
}

export function codexArgv(command: string, request: HarnessRequest): string[] {
  const sandbox = request.capabilities.includes("edit-files") ? "workspace-write" : "read-only";
  return [
    command,
    "exec",
    "--json",
    "-s",
    sandbox,
    "--add-dir",
    dataDir(request.env),
    "-C",
    request.cwd,
    "-m",
    request.model,
    request.brief,
  ];
}

export function codexResumeArgv(
  command: string,
  providerSessionId: string,
  request: HarnessRequest,
): string[] {
  const sandbox = request.capabilities.includes("edit-files") ? "workspace-write" : "read-only";
  return [
    command,
    "exec",
    "resume",
    "--json",
    providerSessionId,
    "-s",
    sandbox,
    "--add-dir",
    dataDir(request.env),
    "-C",
    request.cwd,
    "-m",
    request.model,
    request.brief,
  ];
}

export function codexHarness(command = "codex"): HarnessAdapter {
  return processHarness({
    name: "codex",
    argv: (request) => codexArgv(command, request),
    resumeArgv: (providerSessionId, request) => codexResumeArgv(command, providerSessionId, request),
    parse: parseCodexHarnessEvent,
  });
}
