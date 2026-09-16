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
} from "./records";

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
    // session_meta
    timestamp?: string;
    cwd?: string;
    originator?: string;
    cli_version?: string;
    source?: string;
    thread_source?: string;
    model_provider?: string;
    history_mode?: string;
    git?: { branch?: string };
    // turn_context
    turn_id?: string;
    model?: string;
    // token_usage_record
    response_id?: string;
    usage?: CodexUsage;
    // event_msg task_complete / turn_aborted
    started_at?: number;
    completed_at?: number;
    duration_ms?: number;
    time_to_first_token_ms?: number;
    reason?: string;
    // event_msg item_completed
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

/** Codex reports a command duration as a {secs, nanos} struct. */
function durationMs(d: { secs?: number; nanos?: number } | undefined): number | undefined {
  if (!d) return undefined;
  return Math.round((d.secs ?? 0) * 1000 + (d.nanos ?? 0) / 1e6);
}

function msSince(value: number | undefined): string | undefined {
  return value == null ? undefined : new Date(value).toISOString();
}

/** A command arrives as an argv array; join it so a rule can match the text. */
function commandText(value: unknown): string | undefined {
  return Array.isArray(value) ? value.map(String).join(" ") : undefined;
}

/** Codex reports turn boundaries in epoch seconds. */
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

/**
 * Codex names no model on a message or a usage record, only on the turn they
 * belong to, so `state` carries the turn in effect across chunk boundaries.
 */
export function parseCodexChunk(lines: string[], threadId: string, state: CodexState): ParsedChunk {
  const session: SessionFacts[] = [];
  const messages: MessageRow[] = [];
  const usage: UsageRow[] = [];
  const turns: TurnRow[] = [];
  const costs: CostRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  let current: CodexState = { ...state };

  for (const raw of lines) {
    if (raw.length === 0) continue;
    let line: CodexLine;
    try {
      line = JSON.parse(raw) as CodexLine;
    } catch {
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
      // Open the turn here so its model comes from its own context. Taking the
      // model in effect when task_complete arrives attributes the turn to
      // whichever turn started next.
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
      // Rollouts written before roughly August 2026 leave `id` null, so the
      // record is addressed the way the design addresses every Codex line.
      const id = nonEmpty(p.id) ?? `${threadId}:${ordinal}`;
      messages.push({
        id,
        ts: line.timestamp ?? "",
        role: p.role,
        model: p.role === "assistant" ? current.model : undefined,
        turnId: current.turnId,
        isMeta: false,
        isSkillBody: false,
        text: visibleText(p.content),
        srcLine: ordinal,
        extra: jsonOrUndefined({ content_types: p.content?.map((c) => c?.type).filter(Boolean) }),
      });
      continue;
    }

    // task_complete also carries last_agent_message, the whole assistant reply.
    // It is already a message row, and turn rows hold no text.
    if (line.type === "event_msg" && (p.type === "task_complete" || p.type === "turn_aborted") && p.turn_id) {
      turns.push({
        turnId: p.turn_id,
        tsStart: epochSeconds(p.started_at),
        tsEnd: epochSeconds(p.completed_at) ?? line.timestamp ?? "",
        durationMs: p.duration_ms,
        messageCount: undefined,
        status: p.type === "task_complete" ? "completed" : (nonEmpty(p.reason) ?? "aborted"),
        // Left unset so the model recorded by this turn's own turn_context stands.
        model: undefined,
        timeToFirstTokenMs: p.time_to_first_token_ms,
      });
      continue;
    }

    if (line.type === "event_msg" && p.type === "item_completed" && p.item?.id) {
      const item = p.item;
      const kind = item.type ?? "";
      // Only the kinds that are a tool doing something; AgentMessage, Reasoning
      // and UserMessage are already message rows.
      if (kind === "CommandExecution" || kind === "FileChange" || kind === "McpToolCall") {
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
          // stdout and stderr are measured here and stored nowhere.
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

  return { session, messages, usage, turns, costs, toolCalls, cursorState: JSON.stringify(current) };
}
