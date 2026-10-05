import { z } from "zod";
import type { MessageRow, ParsedChunk, SessionFacts, ToolCallRow } from "./ingest-session-records";

const GrokContent = z.looseObject({ type: z.string().optional(), text: z.string().optional() });
type GrokContent = z.infer<typeof GrokContent>;

const GrokUpdate = z.looseObject({
  sessionUpdate: z.string().optional(),
  content: GrokContent.nullish(),
  toolCallId: z.string().optional(),
  rawInput: z.record(z.string(), z.unknown()).nullish(),
  locations: z.array(z.looseObject({ path: z.string().nullish() })).nullish(),
  status: z.string().nullish(),
  _meta: z
    .looseObject({
      modelId: z.string().nullish(),
      "x.ai/tool": z.looseObject({ name: z.string().nullish() }).nullish(),
    })
    .nullish(),
});
type GrokUpdate = z.infer<typeof GrokUpdate>;

const GrokLine = z.looseObject({
  timestamp: z.number().optional(),
  params: z
    .looseObject({
      update: GrokUpdate.optional(),
      _meta: z
        .looseObject({ eventId: z.string().optional(), agentTimestampMs: z.number().optional() })
        .optional(),
    })
    .optional(),
});
type GrokLine = z.infer<typeof GrokLine>;

function iso(ms: number | undefined, seconds: number | undefined): string | undefined {
  const value = ms ?? (seconds == null ? undefined : seconds * 1000);
  if (value == null || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

function textOf(content: GrokContent | null | undefined): string | undefined {
  if (content?.type !== "text" || content.text === undefined || content.text === "") return undefined;
  return content.text;
}

function stringField(raw: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = raw?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value != null && value !== "" ? value : undefined;
}

function filePathOf(update: GrokUpdate): string | undefined {
  const fromInput = stringField(update.rawInput, "file_path") ?? stringField(update.rawInput, "target_file");
  if (fromInput) return fromInput;
  const located = update.locations?.find((location) => nonEmpty(location.path));
  return nonEmpty(located?.path);
}

function toolNameOf(update: GrokUpdate): string {
  return update._meta?.["x.ai/tool"]?.name ?? "";
}

function parseLine(raw: string): GrokLine | undefined {
  try {
    const parsed = GrokLine.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function parseGrokChunk(lines: string[], firstLineNumber: number): ParsedChunk {
  const session: SessionFacts[] = [];
  const messages: MessageRow[] = [];
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
    const update = line.params?.update;
    const kind = update?.sessionUpdate;
    const ts = iso(line.params?._meta?.agentTimestampMs, line.timestamp);
    if (ts) session.push({ ts });
    if (!update || !kind || !ts) continue;

    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
      const text = textOf(update.content);
      const id = line.params?._meta?.eventId;
      if (!text || !id) continue;
      messages.push({
        id,
        ts,
        role: kind === "user_message_chunk" ? "user" : "assistant",
        model: update._meta?.modelId ?? undefined,
        isMeta: false,
        isSkillBody: false,
        text,
        srcLine,
      });
      continue;
    }

    if (kind !== "tool_call" && kind !== "tool_call_update") continue;
    const id = update.toolCallId;
    if (!id) continue;
    const failed = update.status === "failed" || update.status === "error";
    const finished = update.status === "completed" || failed;
    toolCalls.push({
      id,
      tsCall: kind === "tool_call" ? ts : undefined,
      tsResult: finished ? ts : undefined,
      toolName: toolNameOf(update),
      filePath: filePathOf(update),
      command: stringField(update.rawInput, "command"),
      isError: failed ? true : undefined,
      srcLineCall: kind === "tool_call" ? srcLine : undefined,
      srcLineResult: kind === "tool_call_update" ? srcLine : undefined,
    });
  }

  return { session, messages, usage: [], turns: [], toolCalls, skillLoads: [], dropped };
}
