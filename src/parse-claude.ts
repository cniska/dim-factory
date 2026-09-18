import {
  type CostRow,
  jsonOrUndefined,
  type MessageRow,
  type ParsedChunk,
  projectOf,
  type SessionFacts,
  type ToolCallRow,
  type TurnRow,
  type UsageRow,
} from "./session-records";

import { parseSkillBody, type SkillLoadRow, sha256, skillFromCommand } from "./skill-load";

const SKILL_BODY_PREFIX = "Base directory for this skill:";

type ContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
};

type ClaudeToolUseResult = {
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  gitOperation?: unknown;
};

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
  subtype?: string;
  durationMs?: number;
  messageCount?: number;
  totalCostUSD?: number;
  modelUsage?: Record<string, unknown>;
  hasUnknownModelCost?: boolean;
  toolUseResult?: ClaudeToolUseResult;
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

/** How much the tool returned, measured without keeping any of it. */
function resultSize(content: unknown, result: ClaudeToolUseResult | undefined): number | undefined {
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content)
      if (typeof (b as { text?: string })?.text === "string") parts.push((b as { text: string }).text);
  }
  if (typeof result?.stdout === "string") parts.push(result.stdout);
  if (typeof result?.stderr === "string") parts.push(result.stderr);
  return parts.length > 0 ? parts.reduce((n, p) => n + p.length, 0) : undefined;
}

function feedbackText(value: unknown): string | undefined {
  if (value == null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function parseClaudeChunk(
  lines: string[],
  firstLineNumber: number,
  knownSkills: ReadonlySet<string> = new Set(),
): ParsedChunk {
  const session: SessionFacts[] = [];
  const messages: MessageRow[] = [];
  const usage: UsageRow[] = [];
  const turns: TurnRow[] = [];
  const costs: CostRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const skillLoads: SkillLoadRow[] = [];
  const dropped: number[] = [];

  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    let line: ClaudeLine;
    try {
      line = JSON.parse(raw) as ClaudeLine;
    } catch {
      // A half-written line at the end of a live file never reaches here:
      // readChunk stops at the last newline. What does is a complete line that
      // is not JSON, and the cursor advances past it, so it is read once and
      // lost. Dropping it is the only option that does not stall collection,
      // and reporting it is what keeps the loss from being silent.
      dropped.push(firstLineNumber + index);
      continue;
    }
    const srcLine = firstLineNumber + index;

    if (line.type === "ai-title" || line.type === "custom-title") {
      const title = nonEmpty(line.aiTitle) ?? nonEmpty(line.customTitle);
      if (title) session.push({ title });
      continue;
    }

    if (line.type === "system" && line.subtype === "turn_duration" && line.uuid && line.timestamp) {
      // The line marks the end of the turn; the start is what it took to get there.
      const end = Date.parse(line.timestamp);
      turns.push({
        turnId: line.uuid,
        tsStart:
          Number.isFinite(end) && line.durationMs != null
            ? new Date(end - line.durationMs).toISOString()
            : undefined,
        tsEnd: line.timestamp,
        durationMs: line.durationMs,
        messageCount: line.messageCount,
        status: "completed",
      });
      continue;
    }

    if (line.type === "cost-state" && line.modelUsage) {
      costs.push({
        reportedBy: "claude-code cost-state",
        totalCostUsd: line.totalCostUSD,
        modelUsage: JSON.stringify(line.modelUsage),
        hasUnknownModelCost: line.hasUnknownModelCost,
        ts: nonEmpty(line.timestamp),
      });
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
      if (Array.isArray(line.message.content)) {
        for (const block of line.message.content) {
          if (block?.type !== "tool_use" || !block.id || !block.name) continue;
          const chosen = (block.input as { skill?: unknown } | undefined)?.skill;
          if (block.name === "Skill" && typeof chosen === "string") {
            skillLoads.push({
              messageId: line.message.id,
              ts: line.timestamp ?? "",
              model,
              skillName: chosen,
              how: "model",
            });
          }
          const input = (block.input ?? {}) as Record<string, unknown>;
          toolCalls.push({
            id: block.id,
            messageId: line.message.id,
            model,
            attributionSkill: nonEmpty(line.attributionSkill),
            tsCall: line.timestamp,
            toolName: block.name,
            skillName: typeof input.skill === "string" ? input.skill : undefined,
            filePath: typeof input.file_path === "string" ? input.file_path : undefined,
            command: typeof input.command === "string" ? input.command : undefined,
            srcLineCall: srcLine,
          });
        }
      }
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
      if (Array.isArray(line.message?.content)) {
        for (const block of line.message.content) {
          if (block?.type !== "tool_result" || !block.tool_use_id) continue;
          const r = line.toolUseResult;
          toolCalls.push({
            id: block.tool_use_id,
            toolName: "", // the call record names it; this row only completes one
            tsResult: line.timestamp,
            isError: block.is_error === true,
            interrupted: r?.interrupted === true,
            // Bash stdout and stderr are measured, never stored.
            resultBytes: resultSize(block.content, r),
            gitOperation: r?.gitOperation ? JSON.stringify(r.gitOperation) : undefined,
            srcLineResult: srcLine,
          });
        }
      }
      session.push({
        ts: line.timestamp,
        cwd: line.cwd,
        project: projectOf(line.cwd),
        gitBranch: nonEmpty(line.gitBranch),
        cliVersion: nonEmpty(line.version),
        entrypoint: nonEmpty(line.entrypoint),
      });
      const named = text ? skillFromCommand(text) : undefined;
      // Claude Code's built-in commands share the /name syntax; only a name that
      // is an installed skill is a load.
      const typed = named && knownSkills.has(named) ? named : undefined;
      if (typed) {
        skillLoads.push({
          messageId: line.uuid,
          ts: line.timestamp ?? "",
          skillName: typed,
          how: "user",
        });
      }
      const body = line.isMeta === true && text ? parseSkillBody(text) : undefined;
      if (body) {
        skillLoads.push({
          messageId: line.uuid,
          ts: line.timestamp ?? "",
          skillName: body.name,
          how: "model",
          bodyChars: body.body.length,
          bodySha256: sha256(body.body),
          skillPath: body.path,
        });
      }
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
        text: body ? undefined : text,
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

  return { session, messages, usage, turns, costs, toolCalls, skillLoads, dropped };
}
