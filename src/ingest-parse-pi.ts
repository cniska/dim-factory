import { z } from "zod";
import {
  type MessageRow,
  type ParsedChunk,
  projectOf,
  type SessionFacts,
  type ToolCallRow,
  type UsageRow,
} from "./ingest-session-records";

const PiContent = z.looseObject({
  type: z.string().optional(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const PiMessage = z.looseObject({
  role: z.string().optional(),
  content: z.array(PiContent).optional(),
  model: z.string().optional(),
  usage: z
    .looseObject({
      input: z.number().optional(),
      output: z.number().optional(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
    })
    .optional(),
  responseId: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
});
type PiMessage = z.infer<typeof PiMessage>;

const PiLine = z.looseObject({
  type: z.string().optional(),
  id: z.string().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  title: z.string().optional(),
  message: PiMessage.optional(),
});
type PiLine = z.infer<typeof PiLine>;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function textOf(content: PiMessage["content"]): string | undefined {
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

function parseLine(raw: string): PiLine | undefined {
  try {
    const parsed = PiLine.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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
    const line = parseLine(raw);
    if (!line) {
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

  return { session, messages, usage, turns: [], toolCalls, skillLoads: [], dropped };
}
