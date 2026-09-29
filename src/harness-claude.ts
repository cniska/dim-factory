import { readFileSync } from "node:fs";
import { checkoutGitPaths } from "./git-checkout-dir";
import type { HarnessEvent, HarnessRequest, UsageLimit } from "./harness";
import type { HarnessLineParser, HarnessProcess } from "./harness-process";
import { hookSettings } from "./hook-commands";
import { dataDir } from "./paths";
import { SKILL_PLUGIN_DIR } from "./skill-plugin";
import { NETWORK_VARS } from "./worker-process-environment";

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
  rate_limit_info?: { status?: string; resetsAt?: number };
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
  let usageLimit: UsageLimit | undefined;
  return (line) => {
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      return { type: "diagnostic", level: "error", message: "Claude emitted invalid JSON" };
    }
    if (event.type === "system" && event.subtype === "init") {
      if (!event.apiKeySource) {
        return {
          type: "run.failed",
          reason: "Claude did not report its API key source; cannot verify billing for this worker",
        };
      }
      if (event.apiKeySource !== "none") {
        return {
          type: "run.failed",
          reason: `Claude would bill this worker per token through ${event.apiKeySource}; sign in with a subscription instead`,
        };
      }
      return [{ type: "run.started", providerSessionId: event.session_id }, { type: "turn.started" }];
    }
    if (event.type === "rate_limit_event") {
      const info = event.rate_limit_info;
      if (info?.status === "rejected") {
        usageLimit =
          info.resetsAt === undefined ? {} : { resetsAt: new Date(info.resetsAt * 1000).toISOString() };
      }
      return undefined;
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
      return {
        type: "run.failed",
        reason: event.result || event.subtype || "Claude run failed",
        ...(usageLimit ? { usageLimit } : {}),
      };
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
    hooks: hookSettings("claude", request.env),
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
      filesystem: { denyWrite: edits ? protectedGit : [request.cwd, ...outside(request.cwd, protectedGit)] },
    },
  });
}

function outside(cwd: string, paths: string[]): string[] {
  return paths.filter((path) => path !== cwd && !path.startsWith(`${cwd}/`));
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
    "--setting-sources",
    "",
    "--plugin-dir",
    SKILL_PLUGIN_DIR,
    "--settings",
    claudeSettings(request, checkoutGitPaths(request.cwd)),
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

const SUBSCRIPTION_VARS = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"];

export const claudeProcess: HarnessProcess = {
  command: "claude",
  args: claudeArgs,
  resumeArgs: claudeResumeArgs,
  parser: claudeEventParser,
  environment: [...SUBSCRIPTION_VARS, ...NETWORK_VARS],
};
