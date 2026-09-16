import {
  jsonOrUndefined,
  type MessageRow,
  type ParsedChunk,
  projectOf,
  type SessionFacts,
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
  };
};

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

  return { session, messages, usage, cursorState: JSON.stringify(current) };
}
