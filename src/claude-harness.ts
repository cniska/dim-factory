import { readFileSync } from "node:fs";
import { gitMetadataDirs, protectedGitPaths } from "./git-metadata-dirs";
import type { HarnessEvent, HarnessRequest } from "./harness";
import type { HarnessLineParser, HarnessProcess, ProcessEnvironment } from "./harness-process";
import { dataDir } from "./paths";
import { trunkRefPaths } from "./trunk";

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
  /** Which API key the run uses, if any; `none` means no key and no apiKeyHelper. */
  apiKeySource?: string;
  is_error?: boolean;
  result?: string;
  /** The answer validated against `--json-schema`, which `result` carries only as text. */
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

/** Stateful because a `tool_result` names only the id of the `tool_use` it answers. */
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
      // An apiKeyHelper survives both the environment filter and the blanked settings, and
      // the init event is where Claude says it chose one.
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

/**
 * Bash runs inside Claude Code's OS sandbox, which confines writes to the cwd and each
 * `--add-dir`, and is allowed without a prompt only because of it. `failIfUnavailable`
 * stops a worker from running unconfined on a machine where the sandbox cannot start.
 * A worker without `edit-files` loses the editing tools and has the cwd denied to the
 * sandbox, leaving `dim`'s data directory, and the session's `$TMPDIR` that Claude always
 * grants, as the places it can write. A worker with it reaches the
 * git metadata so it can commit, with the paths there that decide what the operator's own git
 * runs and shows, and the refs that decide what the trunk holds, denied to its sandbox and to
 * its editing tools alike.
 */
function claudeSettings(request: HarnessRequest, protectedGit: string[]): string {
  const edits = request.capabilities.includes("edit-files");
  return JSON.stringify({
    env: Object.fromEntries(PER_TOKEN_VARS.map((name) => [name, ""])),
    permissions: {
      deny: edits
        ? protectedGit.flatMap((path) => [`Edit(/${path})`, `Edit(/${path}/**)`])
        : ["Edit", "Write", "NotebookEdit"],
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

function builderDenials(cwd: string, gitDirs: string[]): string[] {
  const common = gitDirs.at(-1);
  return [...protectedGitPaths(cwd), ...(common ? trunkRefPaths(cwd, common) : [])];
}

function claudeFlags(request: HarnessRequest): string[] {
  const edits = request.capabilities.includes("edit-files");
  const gitDirs = edits ? gitMetadataDirs(request.cwd) : [];
  const dirs = [dataDir(request.env), ...gitDirs];
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    edits ? "acceptEdits" : "default",
    "--settings",
    claudeSettings(request, edits ? builderDenials(request.cwd, gitDirs) : []),
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

/**
 * Credentials and providers that bill a worker per token instead of the subscription the
 * operator is signed in with. The shell's copies are left out of the child's environment, and
 * the launch settings blank them, since they outrank a user's own settings `env`.
 */
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
