import {
  type MessageRow,
  type ParsedChunk,
  projectOf,
  type SessionFacts,
  type ToolCallRow,
  type UsageRow,
} from "./ingest-session-records";

type PiContent =
  | { type: "text"; text?: string }
  | { type: "thinking" }
  | { type: "toolCall"; id?: string; name?: string; arguments?: Record<string, unknown> };

type PiUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  reasoningTokens?: number;
};

type PiMessage = {
  role?: string;
  content?: PiContent[];
  model?: string;
  usage?: PiUsage;
  responseId?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

type PiLine = {
  type?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  title?: string;
  model?: string;
  modelId?: string;
  message?: PiMessage;
};

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function textOf(content: readonly PiContent[] | undefined): string | undefined {
  const text = (content ?? [])
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");
  return text === "" ? undefined : text;
}

function usageOf(message: PiMessage, ts: string, messageId: string | undefined): UsageRow[] {
  const { usage, responseId } = message;
  if (usage === undefined || responseId === undefined) return [];
  return [
    {
      responseId,
      ts,
      model: message.model,
      inputTokens: usage.input ?? 0,
      cacheReadTokens: usage.cacheRead ?? 0,
      cacheWriteTokens: usage.cacheWrite ?? 0,
      outputTokens: usage.output ?? 0,
      reasoningTokens: usage.reasoning ?? usage.reasoningTokens,
      messageId,
    },
  ];
}

function callsOf(message: PiMessage, ts: string, srcLine: number): ToolCallRow[] {
  return (message.content ?? []).flatMap((part): ToolCallRow[] => {
    if (part.type !== "toolCall" || part.id === undefined) return [];
    return [
      {
        id: part.id,
        tsCall: ts,
        toolName: part.name ?? "",
        filePath: nonEmpty(part.arguments?.path),
        command: nonEmpty(part.arguments?.command),
        model: message.model,
        srcLineCall: srcLine,
      },
    ];
  });
}

export function parsePiChunk(lines: string[], firstLineNumber: number): ParsedChunk {
  const session: SessionFacts[] = [];
  const messages: MessageRow[] = [];
  const usage: UsageRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const dropped: number[] = [];

  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    const srcLine = firstLineNumber + index;
    let line: PiLine;
    try {
      line = JSON.parse(raw) as PiLine;
    } catch {
      dropped.push(srcLine);
      continue;
    }
    const ts = line.timestamp;
    switch (line.type) {
      case "session":
        session.push({ ts, cwd: line.cwd, project: projectOf(line.cwd) });
        continue;
      case "title":
      case "title_change":
        if (line.title) session.push({ title: line.title });
        continue;
      case "model_change": {
        const model = nonEmpty(line.modelId) ?? nonEmpty(line.model);
        if (model) session.push({ ts, model });
        continue;
      }
      case "message":
        break;
      default:
        continue;
    }
    const { message, id } = line;
    if (message === undefined || id === undefined || ts === undefined) continue;
    if (message.role === "toolResult") {
      if (message.toolCallId === undefined) continue;
      toolCalls.push({
        id: message.toolCallId,
        tsResult: ts,
        toolName: message.toolName ?? "",
        isError: message.isError,
        srcLineResult: srcLine,
      });
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textOf(message.content);
    if (text) {
      messages.push({
        id,
        ts,
        role: message.role,
        model: message.model,
        isMeta: false,
        isSkillBody: false,
        text,
        srcLine,
      });
    }
    if (message.role !== "assistant") continue;
    usage.push(...usageOf(message, ts, text ? id : undefined));
    toolCalls.push(...callsOf(message, ts, srcLine));
  }

  return { session, messages, usage, turns: [], costs: [], toolCalls, skillLoads: [], dropped };
}
