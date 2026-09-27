import { readFileSync } from "node:fs";
import { checkoutGitPath } from "./git-checkout-dir";
import type { HarnessEvent, HarnessRequest } from "./harness";
import type { HarnessLineParser, HarnessProcess, ProcessEnvironment } from "./harness-process";

type GrokBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: string | { type?: string; text?: string }[];
};

type GrokEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  apiKeySource?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  structured_output?: unknown;
  message?: string | { content?: GrokBlock[] };
};

const INTERNAL_ERROR_PREFIX = "Internal error: ";

function providerMessage(error: string): string {
  if (!error.startsWith(INTERNAL_ERROR_PREFIX)) return error;
  try {
    const detail: unknown = JSON.parse(error.slice(INTERNAL_ERROR_PREFIX.length));
    if (detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string") {
      return detail.message;
    }
  } catch {}
  return error;
}

function failureReason(event: GrokEvent): string {
  if (event.errors?.length) return event.errors.map(providerMessage).join("; ");
  return event.result || event.subtype || "Grok run failed";
}

function resultText(content: GrokBlock["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
}

function grokEventParser(): HarnessLineParser {
  const toolNames = new Map<string, string>();
  return (line) => {
    let event: GrokEvent;
    try {
      event = JSON.parse(line) as GrokEvent;
    } catch {
      return { type: "diagnostic", level: "error", message: "Grok emitted invalid JSON" };
    }
    if (event.type === "system" && event.subtype === "init") {
      if (!event.apiKeySource) {
        return {
          type: "run.failed",
          reason: "Grok did not report its API key source; cannot verify billing for this worker",
        };
      }
      if (event.apiKeySource === "user") {
        return {
          type: "run.failed",
          reason:
            "Grok would bill this worker per token through an API key; sign in with a subscription instead",
        };
      }
      if (event.apiKeySource !== "oauth") {
        return {
          type: "run.failed",
          reason: `Grok reported an API key source of ${event.apiKeySource}; a worker must use a subscription`,
        };
      }
      if (!event.session_id) {
        return { type: "run.failed", reason: "Grok did not report a session id" };
      }
      return [{ type: "run.started", providerSessionId: event.session_id }, { type: "turn.started" }];
    }
    const body = typeof event.message === "object" ? event.message : undefined;
    if (event.type === "assistant") {
      return (body?.content ?? []).flatMap((block): HarnessEvent[] => {
        if (block.type === "text" && block.text)
          return [{ type: "message", role: "assistant", text: block.text }];
        if (block.type !== "tool_use" || !block.name) return [];
        if (block.id) toolNames.set(block.id, block.name);
        return [{ type: "tool.started", name: block.name, toolId: block.id }];
      });
    }
    if (event.type === "user") {
      return (body?.content ?? []).flatMap((block): HarnessEvent[] => {
        if (block.type !== "tool_result") return [];
        const toolId = block.tool_use_id;
        const name = (toolId && toolNames.get(toolId)) || "tool_result";
        const text = resultText(block.content);
        return [
          ...(text ? [{ type: "tool.output", name, text, toolId } as const] : []),
          { type: "tool.completed", name, toolId },
        ];
      });
    }
    if (event.type === "result") {
      if (event.subtype === "success" && !event.is_error) {
        const output =
          event.structured_output === undefined ? event.result : JSON.stringify(event.structured_output);
        return { type: "run.completed", output };
      }
      return { type: "run.failed", reason: failureReason(event) };
    }
    if (event.type === "error") {
      return {
        type: "run.failed",
        reason: (typeof event.message === "string" && event.message) || "Grok failed",
      };
    }
    return undefined;
  };
}

const EDIT_TOOLS = ["Edit", "Write"];

function deny(rule: string): string[] {
  return ["--deny", rule];
}

function editDenies(request: HarnessRequest): string[] {
  if (!request.capabilities.includes("edit-files")) {
    return EDIT_TOOLS.flatMap((tool) => deny(tool));
  }
  const git = checkoutGitPath(request.cwd);
  if (!git) return [];
  return EDIT_TOOLS.flatMap((tool) => [...deny(`${tool}(/${git})`), ...deny(`${tool}(/${git}/**)`)]);
}

function grokFlags(request: HarnessRequest): string[] {
  const edits = request.capabilities.includes("edit-files");
  return [
    "--no-auto-update",
    "--output-format",
    "streaming-messages-json",
    "--permission-mode",
    "bypassPermissions",
    "--sandbox",
    edits ? "workspace" : "read-only",
    ...editDenies(request),
    ...(request.outputSchema ? ["--json-schema", readFileSync(request.outputSchema, "utf8")] : []),
    "--model",
    request.model,
  ];
}

export function grokArgs(request: HarnessRequest): string[] {
  return [...grokFlags(request), "-p", request.brief];
}

export function grokResumeArgs(providerSessionId: string, request: HarnessRequest): string[] {
  return ["--resume", providerSessionId, ...grokArgs(request)];
}

function withoutApiKey(inherited: ProcessEnvironment): ProcessEnvironment {
  return Object.fromEntries(
    Object.entries(inherited).filter(([name]) => name !== "XAI_API_KEY" && name !== "GROK_CODE_XAI_API_KEY"),
  );
}

export const grokProcess: HarnessProcess = {
  command: "grok",
  args: grokArgs,
  resumeArgs: grokResumeArgs,
  parser: grokEventParser,
  environment: withoutApiKey,
};
