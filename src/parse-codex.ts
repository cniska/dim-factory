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
import { type SkillLoadRow, skillFromFileRead } from "./skill-load";

export type CodexState = { model?: string; turnId?: string };

type CodexContent = { type?: string; text?: string };

type CodexUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};

type CodexLine = {
  type?: string;
  timestamp?: string;
  ordinal?: number;
  payload?: {
    type?: string;
    id?: string | null;
    role?: string;
    content?: CodexContent[];
    timestamp?: string;
    cwd?: string;
    originator?: string;
    cli_version?: string;
    source?: string;
    thread_source?: string;
    model_provider?: string;
    history_mode?: string;
    git?: { branch?: string };
    turn_id?: string;
    model?: string;
    response_id?: string;
    usage?: CodexUsage;
    started_at?: number;
    completed_at?: number;
    duration_ms?: number;
    time_to_first_token_ms?: number;
    reason?: string;
    started_at_ms?: number;
    completed_at_ms?: number;
    item?: {
      id?: string;
      type?: string;
      command?: unknown;
      changes?: Record<string, unknown>;
      status?: string;
      exit_code?: number;
      duration?: { secs?: number; nanos?: number };
      stdout?: string;
      stderr?: string;
      server?: string;
      tool?: string;
    };
  };
};

function durationMs(d: { secs?: number; nanos?: number } | undefined): number | undefined {
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

function visibleText(content: CodexContent[] | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((b) => typeof b?.text === "string").map((b) => b.text as string);
  return parts.length > 0 ? parts.join("\n") : undefined;
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
  const costs: CostRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const skillLoads: SkillLoadRow[] = [];
  const dropped: number[] = [];
  let current: CodexState = { ...state };

  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    let line: CodexLine;
    try {
      line = JSON.parse(raw) as CodexLine;
    } catch {
      dropped.push(firstLineNumber + index);
      continue;
    }
    const p = line.payload;
    if (!p) continue;
    const ordinal = line.ordinal ?? 0;

    if (line.type === "session_meta") {
      session.push({
        ts: p.timestamp ?? line.timestamp,
        cwd: p.cwd,
        project: projectOf(p.cwd),
        gitBranch: nonEmpty(p.git?.branch),
        cliVersion: nonEmpty(p.cli_version),
        entrypoint: nonEmpty(p.originator),
        extra: jsonOrUndefined({
          source: p.source,
          thread_source: p.thread_source,
          model_provider: p.model_provider,
          history_mode: p.history_mode,
        }),
      });
      continue;
    }

    if (line.type === "turn_context") {
      current = {
        model: nonEmpty(p.model) ?? current.model,
        turnId: nonEmpty(p.turn_id) ?? current.turnId,
      };
      session.push({
        ts: line.timestamp,
        cwd: p.cwd,
        project: projectOf(p.cwd),
        model: current.model,
      });
      if (current.turnId) {
        turns.push({
          turnId: current.turnId,
          tsEnd: line.timestamp ?? "",
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

      const id = nonEmpty(p.id) ?? `${threadId}:${ordinal}`;
      messages.push({
        id,
        ts: line.timestamp ?? "",
        role: p.role,
        model: p.role === "assistant" ? current.model : undefined,
        turnId: current.turnId,
        promptSource,
        isMeta: false,
        isSkillBody: false,
        text,
        srcLine: ordinal,
        extra: jsonOrUndefined({ content_types: p.content?.map((c) => c?.type).filter(Boolean) }),
      });
      continue;
    }

    if (line.type === "event_msg" && (p.type === "task_complete" || p.type === "turn_aborted") && p.turn_id) {
      turns.push({
        turnId: p.turn_id,
        tsStart: epochSeconds(p.started_at),
        tsEnd: epochSeconds(p.completed_at) ?? line.timestamp ?? "",
        durationMs: p.duration_ms,
        messageCount: undefined,
        status: p.type === "task_complete" ? "completed" : (nonEmpty(p.reason) ?? "aborted"),
        model: undefined,
        timeToFirstTokenMs: p.time_to_first_token_ms,
      });
      continue;
    }

    if (line.type === "event_msg" && p.type === "item_completed" && p.item?.id) {
      const item = p.item;
      const kind = item.type ?? "";
      if (kind === "CommandExecution" || kind === "FileChange" || kind === "McpToolCall") {
        const cmd = typeof item.command === "string" ? item.command : commandText(item.command);
        const readSkill = cmd ? skillFromFileRead(cmd) : undefined;
        if (readSkill) {
          skillLoads.push({
            ts: msSince(p.started_at_ms) ?? line.timestamp ?? "",
            model: current.model,
            skillName: readSkill,
            how: "read",
          });
        }
        toolCalls.push({
          id: item.id as string,
          model: current.model,
          tsCall: msSince(p.started_at_ms) ?? line.timestamp,
          tsResult: msSince(p.completed_at_ms) ?? line.timestamp,
          toolName: kind,
          filePath:
            kind === "FileChange" ? Object.keys(item.changes ?? {}).join(" ") || undefined : undefined,
          command: typeof item.command === "string" ? item.command : commandText(item.command),
          isError: item.status != null ? item.status !== "completed" : undefined,
          exitCode: item.exit_code,
          durationMs: durationMs(item.duration),
          resultBytes: (item.stdout?.length ?? 0) + (item.stderr?.length ?? 0) || undefined,
          srcLineCall: ordinal,
          srcLineResult: ordinal,
          extra: jsonOrUndefined({ status: item.status, server: item.server, tool: item.tool }),
        });
      }
      continue;
    }

    if (line.type === "token_usage_record" && p.response_id) {
      const u = p.usage ?? {};
      usage.push({
        responseId: p.response_id,
        ts: line.timestamp ?? "",
        model: current.model,
        inputTokens: u.input_tokens ?? 0,
        cacheReadTokens: u.cached_input_tokens ?? 0,
        cacheWriteTokens: u.cache_write_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        reasoningTokens: u.reasoning_output_tokens,
        extra: jsonOrUndefined({ turn_id: p.turn_id, total_tokens: u.total_tokens }),
      });
    }
  }

  return {
    session,
    messages,
    usage,
    turns,
    costs,
    toolCalls,
    skillLoads,
    dropped,
    cursorState: JSON.stringify(current),
  };
}
