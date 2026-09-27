import type { MessageRow, ParsedChunk, SessionFacts, ToolCallRow } from "./ingest-session-records";

type GrokContent = { type?: string; text?: string };

type GrokToolMeta = { name?: string };

type GrokUpdate = {
  sessionUpdate?: string;
  content?: GrokContent;
  toolCallId?: string;
  rawInput?: Record<string, unknown>;
  locations?: { path?: string }[];
  status?: string;
  _meta?: { modelId?: string; "x.ai/tool"?: GrokToolMeta };
};

type GrokLine = {
  timestamp?: number;
  params?: {
    update?: GrokUpdate;
    _meta?: { eventId?: string; agentTimestampMs?: number };
  };
};

function iso(ms: number | undefined, seconds: number | undefined): string | undefined {
  const value = ms ?? (seconds == null ? undefined : seconds * 1000);
  if (value == null || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

function textOf(content: GrokContent | undefined): string | undefined {
  if (content?.type !== "text" || typeof content.text !== "string" || content.text === "") return undefined;
  return content.text;
}

function stringField(raw: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = raw?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function filePathOf(update: GrokUpdate): string | undefined {
  const fromInput = stringField(update.rawInput, "file_path") ?? stringField(update.rawInput, "target_file");
  if (fromInput) return fromInput;
  const located = update.locations?.find(
    (location) => typeof location.path === "string" && location.path !== "",
  );
  return located?.path;
}

function toolNameOf(update: GrokUpdate): string {
  const name = update._meta?.["x.ai/tool"]?.name;
  return typeof name === "string" ? name : "";
}

export function parseGrokChunk(lines: string[], firstLineNumber: number): ParsedChunk {
  const session: SessionFacts[] = [];
  const messages: MessageRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const dropped: number[] = [];

  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    const srcLine = firstLineNumber + index;
    let line: GrokLine;
    try {
      line = JSON.parse(raw) as GrokLine;
    } catch {
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
        model: update._meta?.modelId,
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

  return { session, messages, usage: [], turns: [], costs: [], toolCalls, skillLoads: [], dropped };
}
