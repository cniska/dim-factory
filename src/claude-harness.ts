import { readFileSync } from "node:fs";
import { checkoutGitPath } from "./checkout-git";
import type { HarnessEvent, HarnessRequest } from "./harness";
import type { HarnessLineParser, HarnessProcess, ProcessEnvironment } from "./harness-process";
import { dataDir } from "./paths";

type ClaudeBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: string | { type?: string; text?: string }[];
};

type ClaudeEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  apiKeySource?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  message?: { content?: ClaudeBlock[] };
};

function resultText(content: ClaudeBlock["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
}

function claudeEventParser(): HarnessLineParser {
  const toolNames = new Map<string, string>();
  return (line) => {
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      return { type: "diagnostic", level: "error", message: "Claude emitted invalid JSON" };
    }
    if (event.type === "system" && event.subtype === "init") {
      if (event.apiKeySource !== undefined && event.apiKeySource !== "none") {
        return {
          type: "run.failed",
          reason: `Claude would bill this worker per token through ${event.apiKeySource}; sign in with a subscription instead`,
        };
      }
      return [{ type: "run.started", providerSessionId: event.session_id }, { type: "turn.started" }];
    }
    if (event.type === "assistant") {
      return (event.message?.content ?? []).flatMap((block): HarnessEvent[] => {
        if (block.type === "text" && block.text)
          return [{ type: "message", role: "assistant", text: block.text }];
        if (block.type !== "tool_use" || !block.name) return [];
        if (block.id) toolNames.set(block.id, block.name);
        return [{ type: "tool.started", name: block.name, toolId: block.id }];
      });
    }
    if (event.type === "user") {
      return (event.message?.content ?? []).flatMap((block): HarnessEvent[] => {
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
      return { type: "run.failed", reason: event.result || event.subtype || "Claude run failed" };
    }
    return undefined;
  };
}

const BACKGROUND_WORK_TOOLS = ["ScheduleWakeup", "CronCreate", "Monitor", "RemoteTrigger"];

function claudeSettings(request: HarnessRequest, protectedGit: string[]): string {
  const edits = request.capabilities.includes("edit-files");
  return JSON.stringify({
    env: {
      ...Object.fromEntries(PER_TOKEN_VARS.map((name) => [name, ""])),
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    },
    permissions: {
      deny: [
        ...(edits
          ? protectedGit.flatMap((path) => [`Edit(/${path})`, `Edit(/${path}/**)`])
          : ["Edit", "Write", "NotebookEdit"]),
        ...BACKGROUND_WORK_TOOLS,
      ],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: edits ? protectedGit : [request.cwd] },
    },
  });
}

function builderDenials(cwd: string): string[] {
  const pointer = checkoutGitPath(cwd);
  return pointer ? [pointer] : [];
}

function claudeFlags(request: HarnessRequest): string[] {
  const edits = request.capabilities.includes("edit-files");
  const dirs = [dataDir(request.env)];
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    edits ? "acceptEdits" : "default",
    "--settings",
    claudeSettings(request, edits ? builderDenials(request.cwd) : []),
    ...(request.outputSchema ? ["--json-schema", readFileSync(request.outputSchema, "utf8")] : []),
    ...dirs.flatMap((dir) => ["--add-dir", dir]),
    "--model",
    request.model,
  ];
}

export function claudeArgs(request: HarnessRequest): string[] {
  return [...claudeFlags(request), "--", request.brief];
}

export function claudeResumeArgs(providerSessionId: string, request: HarnessRequest): string[] {
  return ["--resume", providerSessionId, ...claudeArgs(request)];
}

const PER_TOKEN_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

function withoutPerTokenCredentials(inherited: ProcessEnvironment): ProcessEnvironment {
  return Object.fromEntries(Object.entries(inherited).filter(([name]) => !PER_TOKEN_VARS.includes(name)));
}

export const claudeProcess: HarnessProcess = {
  command: "claude",
  args: claudeArgs,
  resumeArgs: claudeResumeArgs,
  parser: claudeEventParser,
  environment: withoutPerTokenCredentials,
};
