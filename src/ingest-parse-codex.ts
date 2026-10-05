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
import { type SkillLoadRow, skillFromFileRead } from "./ingest-skill-load";

export const CodexState = z.looseObject({ model: z.string().optional(), turnId: z.string().optional() });
export type CodexState = z.infer<typeof CodexState>;

const CodexContent = z.looseObject({ type: z.string().optional(), text: z.string().optional() });

const CodexUsage = z.looseObject({
  input_tokens: z.number().optional(),
  cached_input_tokens: z.number().optional(),
  cache_write_input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
});

const CodexDuration = z.looseObject({ secs: z.number().optional(), nanos: z.number().optional() });
type CodexDuration = z.infer<typeof CodexDuration>;

const CodexLine = z.looseObject({
  type: z.string().optional(),
  timestamp: z.string().optional(),
  payload: z
    .looseObject({
      type: z.string().optional(),
      id: z.string().nullish(),
      role: z.string().optional(),
      content: z.array(CodexContent.nullable()).optional(),
      timestamp: z.string().optional(),
      cwd: z.string().optional(),
      originator: z.string().nullish(),
      cli_version: z.string().nullish(),
      git: z.looseObject({ branch: z.string().optional() }).optional(),
      turn_id: z.string().nullish(),
      model: z.string().nullish(),
      response_id: z.string().optional(),
      usage: CodexUsage.nullish(),
      started_at: z.number().optional(),
      completed_at: z.number().optional(),
      duration_ms: z.number().optional(),
      time_to_first_token_ms: z.number().optional(),
      reason: z.string().nullish(),
      started_at_ms: z.number().optional(),
      completed_at_ms: z.number().optional(),
      item: z
        .looseObject({
          id: z.string().optional(),
          type: z.string().optional(),
          command: z.unknown().optional(),
          changes: z.record(z.string(), z.unknown()).optional(),
          status: z.string().nullish(),
          exit_code: z.number().optional(),
          duration: CodexDuration.optional(),
          stdout: z.string().optional(),
          stderr: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
type CodexLine = z.infer<typeof CodexLine>;

function durationMs(d: CodexDuration | undefined): number | undefined {
  if (!d) return undefined;
  return Math.round((d.secs ?? 0) * 1000 + (d.nanos ?? 0) / 1e6);
}

function msSince(value: number | undefined): string | undefined {
  return value == null ? undefined : new Date(value).toISOString();
}

function commandText(value: unknown): string | undefined {
  return Array.isArray(value) ? value.map(String).join(" ") : undefined;
}

function epochSeconds(value: number | undefined): string | undefined {
  return value == null ? undefined : new Date(value * 1000).toISOString();
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value != null && value !== "" ? value : undefined;
}

function visibleText(content: (z.infer<typeof CodexContent> | null)[] | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((b) => (b?.text !== undefined ? [b.text] : []));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function parseLine(raw: string): CodexLine | undefined {
  try {
    const parsed = CodexLine.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function parseCodexChunk(
  lines: string[],
  firstLineNumber: number,
  threadId: string,
  state: CodexState,
): ParsedChunk {
  const session: SessionFacts[] = [];
  const messages: MessageRow[] = [];
  const usage: UsageRow[] = [];
  const turns: TurnRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const skillLoads: SkillLoadRow[] = [];
  const dropped: number[] = [];
  let current: CodexState = { ...state };

  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    const line = parseLine(raw);
    if (!line) {
      dropped.push(firstLineNumber + index);
      continue;
    }
    const p = line.payload;
    if (!p) continue;
    const ts = nonEmpty(line.timestamp);
    if (!ts) {
      dropped.push(firstLineNumber + index);
      continue;
    }
    const srcLine = firstLineNumber + index;

    if (line.type === "session_meta") {
      session.push({
        ts: p.timestamp ?? ts,
        cwd: p.cwd,
        project: projectOf(p.cwd),
        gitBranch: nonEmpty(p.git?.branch),
        cliVersion: nonEmpty(p.cli_version),
        entrypoint: nonEmpty(p.originator),
      });
      continue;
    }

    if (line.type === "turn_context") {
      current = {
        model: nonEmpty(p.model) ?? current.model,
        turnId: nonEmpty(p.turn_id) ?? current.turnId,
      };
      session.push({
        ts,
        cwd: p.cwd,
        project: projectOf(p.cwd),
      });
      if (current.turnId) {
        turns.push({
          turnId: current.turnId,
          tsStart: ts,
          status: "started",
          model: current.model,
        });
      }
      continue;
    }

    if (
      line.type === "response_item" &&
      p.type === "message" &&
      (p.role === "user" || p.role === "assistant")
    ) {
      const text = visibleText(p.content);
      const injected = /^\s*(#\s*AGENTS\.md instructions|<[a-z_]+>|\[\s*\{)/.test(text ?? "");
      const promptSource = p.role === "user" ? (injected ? "system" : "typed") : undefined;

      const id = nonEmpty(p.id) ?? `${threadId}:${srcLine}`;
      messages.push({
        id,
        ts,
        role: p.role,
        model: p.role === "assistant" ? current.model : undefined,
        turnId: current.turnId,
        promptSource,
        isMeta: false,
        isSkillBody: false,
        text,
        srcLine,
        extra: jsonOrUndefined({ content_types: p.content?.map((c) => c?.type).filter(Boolean) }),
      });
      continue;
    }

    if (line.type === "event_msg" && (p.type === "task_complete" || p.type === "turn_aborted") && p.turn_id) {
      const status = p.type === "task_complete" ? "completed" : nonEmpty(p.reason);
      if (status === undefined) {
        dropped.push(srcLine);
        continue;
      }
      turns.push({
        turnId: p.turn_id,
        tsStart: epochSeconds(p.started_at),
        tsEnd: epochSeconds(p.completed_at) ?? ts,
        durationMs: p.duration_ms,
        messageCount: undefined,
        status,
        model: undefined,
        timeToFirstTokenMs: p.time_to_first_token_ms,
      });
      continue;
    }

    const item = p.item;
    if (line.type === "event_msg" && p.type === "item_completed" && item?.id) {
      const kind = item.type ?? "";
      if (kind === "CommandExecution" || kind === "FileChange" || kind === "McpToolCall") {
        const cmd = typeof item.command === "string" ? item.command : commandText(item.command);
        const readSkill = cmd ? skillFromFileRead(cmd) : undefined;
        if (readSkill) {
          skillLoads.push({
            ts: msSince(p.started_at_ms) ?? ts,
            model: current.model,
            skillName: readSkill,
            how: "read",
          });
        }
        toolCalls.push({
          id: item.id,
          model: current.model,
          tsCall: msSince(p.started_at_ms) ?? ts,
          tsResult: msSince(p.completed_at_ms) ?? ts,
          toolName: kind,
          filePath:
            kind === "FileChange" ? Object.keys(item.changes ?? {}).join(" ") || undefined : undefined,
          command: typeof item.command === "string" ? item.command : commandText(item.command),
          isError: item.status != null ? item.status !== "completed" : undefined,
          exitCode: item.exit_code,
          durationMs: durationMs(item.duration),
          resultBytes: (item.stdout?.length ?? 0) + (item.stderr?.length ?? 0) || undefined,
          srcLineCall: srcLine,
          srcLineResult: srcLine,
        });
      }
      continue;
    }

    if (line.type === "token_usage_record" && p.response_id) {
      const u = p.usage ?? {};
      usage.push({
        responseId: p.response_id,
        ts,
        model: current.model,
        inputTokens: u.input_tokens ?? 0,
        cacheReadTokens: u.cached_input_tokens ?? 0,
        cacheWriteTokens: u.cache_write_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
      });
    }
  }

  return {
    session,
    messages,
    usage,
    turns,
    toolCalls,
    skillLoads,
    dropped,
    cursorState: JSON.stringify(current),
  };
}
