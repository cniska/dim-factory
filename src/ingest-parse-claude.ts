import { z } from "zod";
import {
  jsonOrUndefined,
  type MessageRow,
  type ParsedChunk,
  projectOf,
  type SessionFacts,
  type ToolCallRow,
  type TurnRow,
  type UsageRow,
} from "./ingest-session-records";

import { parseSkillBody, type SkillLoadRow, skillFromCommand } from "./ingest-skill-load";

const SKILL_BODY_PREFIX = "Base directory for this skill:";

const ContentBlock = z.looseObject({
  type: z.string().optional(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()).nullish(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
});
type ContentBlock = z.infer<typeof ContentBlock>;

const ClaudeToolUseResult = z.looseObject({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  interrupted: z.boolean().optional(),
  gitOperation: z.unknown().optional(),
});
type ClaudeToolUseResult = z.infer<typeof ClaudeToolUseResult>;

const ClaudeUsage = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
});

const ClaudeLine = z.looseObject({
  type: z.string().optional(),
  uuid: z.string().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  entrypoint: z.string().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().nullish(),
  session_id: z.string().optional(),
  promptSource: z.string().optional(),
  promptId: z.string().optional(),
  permissionMode: z.string().optional(),
  origin: z.looseObject({ kind: z.string().optional() }).optional(),
  attributionSkill: z.string().nullish(),
  requestId: z.string().optional(),
  effort: z.string().optional(),
  agentId: z.string().optional(),
  parentUuid: z.string().nullish(),
  sourceToolUseID: z.string().nullish(),
  interruptedMessageId: z.string().nullish(),
  toolDenialKind: z.string().nullish(),
  userFeedback: z.unknown().optional(),
  aiTitle: z.string().optional(),
  customTitle: z.string().optional(),
  subtype: z.string().optional(),
  durationMs: z.number().optional(),
  messageCount: z.number().optional(),
  toolUseResult: z.union([ClaudeToolUseResult, z.string().transform(() => undefined)]).optional(),
  message: z
    .looseObject({
      id: z.string().optional(),
      model: z.string().optional(),
      content: z.union([z.string(), z.array(ContentBlock.nullable())]).optional(),
      usage: ClaudeUsage.nullish(),
    })
    .optional(),
});
type ClaudeLine = z.infer<typeof ClaudeLine>;

function visibleText(content: string | (ContentBlock | null)[] | undefined): string | undefined {
  if (typeof content === "string") return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((b) => (b?.type === "text" && b.text !== undefined ? [b.text] : []));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value != null && value !== "" ? value : undefined;
}

function resultSize(content: unknown, result: ClaudeToolUseResult | undefined): number | undefined {
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) if (typeof b?.text === "string") parts.push(b.text);
  }
  if (typeof result?.stdout === "string") parts.push(result.stdout);
  if (typeof result?.stderr === "string") parts.push(result.stderr);
  return parts.length > 0 ? parts.reduce((n, p) => n + p.length, 0) : undefined;
}

function feedbackText(value: unknown): string | undefined {
  if (value == null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseLine(raw: string): ClaudeLine | undefined {
  try {
    const parsed = ClaudeLine.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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
  const toolCalls: ToolCallRow[] = [];
  const skillLoads: SkillLoadRow[] = [];
  const dropped: number[] = [];

  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    const srcLine = firstLineNumber + index;
    const line = parseLine(raw);
    if (!line) {
      dropped.push(srcLine);
      continue;
    }

    if (line.type === "ai-title" || line.type === "custom-title") {
      const title = nonEmpty(line.aiTitle) ?? nonEmpty(line.customTitle);
      if (title) session.push({ title });
      continue;
    }

    const ts = nonEmpty(line.timestamp);

    if (line.type === "system" && line.subtype === "turn_duration" && line.uuid) {
      if (!ts) {
        dropped.push(srcLine);
        continue;
      }
      const end = Date.parse(ts);
      turns.push({
        turnId: line.uuid,
        tsStart:
          Number.isFinite(end) && line.durationMs != null
            ? new Date(end - line.durationMs).toISOString()
            : undefined,
        tsEnd: ts,
        durationMs: line.durationMs,
        messageCount: line.messageCount,
        status: "completed",
      });
      continue;
    }

    if (line.type === "assistant" && line.message?.id) {
      if (!ts) {
        dropped.push(srcLine);
        continue;
      }
      const model = nonEmpty(line.message.model);
      session.push({
        ts,
        cwd: line.cwd,
        project: projectOf(line.cwd),
        gitBranch: nonEmpty(line.gitBranch),
        cliVersion: nonEmpty(line.version),
        entrypoint: nonEmpty(line.entrypoint),
      });
      messages.push({
        id: line.message.id,
        ts,
        role: "assistant",
        model,
        isMeta: false,
        isSkillBody: false,
        attributionSkill: nonEmpty(line.attributionSkill),
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
          const input = block.input ?? {};
          const chosen = input.skill;
          if (block.name === "Skill" && typeof chosen === "string") {
            skillLoads.push({
              messageId: line.message.id,
              ts,
              model,
              skillName: chosen,
              how: "model",
            });
          }
          toolCalls.push({
            id: block.id,
            messageId: line.message.id,
            model,
            attributionSkill: nonEmpty(line.attributionSkill),
            tsCall: ts,
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
          ts,
          model,
          inputTokens: u.input_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          attributionSkill: nonEmpty(line.attributionSkill),
        });
      }
      continue;
    }

    if (line.type === "user" && line.uuid) {
      if (!ts) {
        dropped.push(srcLine);
        continue;
      }
      const text = visibleText(line.message?.content);
      if (Array.isArray(line.message?.content)) {
        for (const block of line.message.content) {
          if (block?.type !== "tool_result" || !block.tool_use_id) continue;
          const r = line.toolUseResult;
          toolCalls.push({
            id: block.tool_use_id,
            toolName: "",
            tsResult: ts,
            isError: block.is_error === true,
            interrupted: r?.interrupted === true,
            resultBytes: resultSize(block.content, r),
            gitOperation: r?.gitOperation ? JSON.stringify(r.gitOperation) : undefined,
            srcLineResult: srcLine,
          });
        }
      }
      session.push({
        ts,
        cwd: line.cwd,
        project: projectOf(line.cwd),
        gitBranch: nonEmpty(line.gitBranch),
        cliVersion: nonEmpty(line.version),
        entrypoint: nonEmpty(line.entrypoint),
      });
      const named = text ? skillFromCommand(text) : undefined;
      const typed = named && knownSkills.has(named) ? named : undefined;
      if (typed) {
        skillLoads.push({
          messageId: line.uuid,
          ts,
          skillName: typed,
          how: "user",
        });
      }
      const body = line.isMeta === true && text ? parseSkillBody(text) : undefined;
      if (body) {
        const { name, ...fields } = body;
        const toolUseId = nonEmpty(line.sourceToolUseID);
        const parentUuid = nonEmpty(line.parentUuid);
        if (toolUseId) skillLoads.push({ toolUseId, ...fields });
        else if (parentUuid) skillLoads.push({ parentUuid, skillName: name, ...fields });
      }
      messages.push({
        id: line.uuid,
        ts,
        role: "user",
        turnId: nonEmpty(line.promptId),
        promptSource: nonEmpty(line.promptSource),
        originKind: nonEmpty(line.origin?.kind),
        isMeta: line.isMeta === true,
        isSkillBody: line.isMeta === true && (text?.startsWith(SKILL_BODY_PREFIX) ?? false),
        slashCommand: named,
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

  return { session, messages, usage, turns, toolCalls, skillLoads, dropped };
}
