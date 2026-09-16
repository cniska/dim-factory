import {
  jsonOrUndefined,
  type MessageRow,
  type ParsedChunk,
  projectOf,
  type SessionFacts,
  type UsageRow,
} from "./records";

const SKILL_BODY_PREFIX = "Base directory for this skill:";

type ContentBlock = { type?: string; text?: string };

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
  output_tokens_details?: { thinking_tokens?: number } | null;
  service_tier?: string | null;
  speed?: string | null;
  server_tool_use?: unknown;
};

type ClaudeLine = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  isSidechain?: boolean;
  isMeta?: boolean | null;
  session_id?: string;
  promptSource?: string;
  promptId?: string;
  permissionMode?: string;
  origin?: { kind?: string };
  attributionSkill?: string | null;
  requestId?: string;
  effort?: string;
  agentId?: string;
  parentUuid?: string | null;
  sourceToolUseID?: string | null;
  interruptedMessageId?: string | null;
  toolDenialKind?: string | null;
  userFeedback?: unknown;
  aiTitle?: string;
  customTitle?: string;
  message?: {
    id?: string;
    model?: string;
    stop_reason?: string | null;
    content?: string | ContentBlock[];
    usage?: ClaudeUsage | null;
  };
};

/**
 * Assistant `text` blocks and plain user strings only. `tool_result` blocks
 * carry command output and file contents and `thinking` blocks carry reasoning;
 * the design keeps both out of the database.
 */
function visibleText(content: string | ContentBlock[] | undefined): string | undefined {
  if (typeof content === "string") return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value != null && value !== "" ? value : undefined;
}

function feedbackText(value: unknown): string | undefined {
  if (value == null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function parseClaudeChunk(lines: string[], firstLineNumber: number): ParsedChunk {
  const session: SessionFacts[] = [];
  const messages: MessageRow[] = [];
  const usage: UsageRow[] = [];

  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    let line: ClaudeLine;
    try {
      line = JSON.parse(raw) as ClaudeLine;
    } catch {
      continue; // a torn line; the cursor will not have advanced past it
    }
    const srcLine = firstLineNumber + index;

    if (line.type === "ai-title" || line.type === "custom-title") {
      const title = nonEmpty(line.aiTitle) ?? nonEmpty(line.customTitle);
      if (title) session.push({ title });
      continue;
    }

    if (line.type === "assistant" && line.message?.id) {
      const model = nonEmpty(line.message.model);
      session.push({
        ts: line.timestamp,
        cwd: line.cwd,
        project: projectOf(line.cwd),
        gitBranch: nonEmpty(line.gitBranch),
        cliVersion: nonEmpty(line.version),
        entrypoint: nonEmpty(line.entrypoint),
        model,
      });
      messages.push({
        id: line.message.id,
        ts: line.timestamp ?? "",
        role: "assistant",
        model,
        isMeta: false,
        isSkillBody: false,
        attributionSkill: nonEmpty(line.attributionSkill),
        stopReason: nonEmpty(line.message.stop_reason),
        text: visibleText(line.message.content),
        srcLine,
        extra: jsonOrUndefined({
          requestId: line.requestId,
          effort: line.effort,
          isSidechain: line.isSidechain,
          agentId: line.agentId,
          uuid: line.uuid,
          session_id: line.session_id,
        }),
      });
      const u = line.message.usage;
      if (u) {
        usage.push({
          responseId: line.message.id,
          messageId: line.message.id,
          ts: line.timestamp ?? "",
          model,
          inputTokens: u.input_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens,
          outputTokens: u.output_tokens ?? 0,
          reasoningTokens: u.output_tokens_details?.thinking_tokens,
          attributionSkill: nonEmpty(line.attributionSkill),
          extra: jsonOrUndefined({
            service_tier: u.service_tier,
            speed: u.speed,
            server_tool_use: u.server_tool_use,
          }),
        });
      }
      continue;
    }

    if (line.type === "user" && line.uuid) {
      const text = visibleText(line.message?.content);
      session.push({
        ts: line.timestamp,
        cwd: line.cwd,
        project: projectOf(line.cwd),
        gitBranch: nonEmpty(line.gitBranch),
        cliVersion: nonEmpty(line.version),
        entrypoint: nonEmpty(line.entrypoint),
      });
      messages.push({
        id: line.uuid,
        ts: line.timestamp ?? "",
        role: "user",
        turnId: nonEmpty(line.promptId),
        promptSource: nonEmpty(line.promptSource),
        originKind: nonEmpty(line.origin?.kind),
        isMeta: line.isMeta === true,
        isSkillBody: line.isMeta === true && (text?.startsWith(SKILL_BODY_PREFIX) ?? false),
        interruptedMessageId: nonEmpty(line.interruptedMessageId),
        denialKind: nonEmpty(line.toolDenialKind),
        userFeedback: feedbackText(line.userFeedback),
        text,
        srcLine,
        extra: jsonOrUndefined({
          isSidechain: line.isSidechain,
          agentId: line.agentId,
          permissionMode: line.permissionMode,
          sourceToolUseID: line.sourceToolUseID,
          parentUuid: line.parentUuid,
          session_id: line.session_id,
        }),
      });
    }
  }

  return { session, messages, usage };
}
