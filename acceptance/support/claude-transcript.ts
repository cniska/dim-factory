import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export type TranscriptEntry =
  | { readonly type: "user"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "tool_result"; readonly id: string; readonly output: string }
  | { readonly type: "assistant"; readonly text: string };

const Block = z.looseObject({ type: z.string() });

type Block = z.infer<typeof Block>;

const Text = z.looseObject({ type: z.literal("text"), text: z.string() });

const Read = z.discriminatedUnion("type", [
  Text,
  z.looseObject({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.looseObject({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(Block).readonly()]),
  }),
]);

const READ_TYPES: readonly string[] = ["text", "tool_use", "tool_result"];

export const ClaudeLine = z.looseObject({
  type: z.string(),
  message: z
    .looseObject({ role: z.string(), content: z.union([z.string(), z.array(Block).readonly()]) })
    .optional(),
});

type ClaudeLine = z.infer<typeof ClaudeLine>;

export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

function entryOf(block: Block): TranscriptEntry | null {
  if (!READ_TYPES.includes(block.type)) return null;
  const read = Read.parse(block);
  switch (read.type) {
    case "text":
      return { type: "assistant", text: read.text };
    case "tool_use":
      return { type: "tool_use", id: read.id, name: read.name, input: read.input };
    case "tool_result": {
      const output =
        typeof read.content === "string"
          ? read.content
          : read.content.flatMap((part) => (part.type === "text" ? [Text.parse(part).text] : [])).join("\n");
      return { type: "tool_result", id: read.tool_use_id, output };
    }
  }
}

function entriesOf(line: ClaudeLine): readonly TranscriptEntry[] {
  const content = line.message?.content;
  if (content === undefined) return [];
  if (typeof content === "string") return line.type === "user" ? [{ type: "user", text: content }] : [];
  return content.flatMap((block) => entryOf(block) ?? []);
}

export function claudeLine(
  sessionId: string,
  cwd: string,
  entry: TranscriptEntry,
): Readonly<Record<string, unknown>> {
  const base = { sessionId, cwd, uuid: crypto.randomUUID(), timestamp: new Date().toISOString() };
  switch (entry.type) {
    case "user":
      return { ...base, type: "user", message: { role: "user", content: entry.text } };
    case "assistant":
      return {
        ...base,
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: entry.text }] },
      };
    case "tool_use":
      return {
        ...base,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: entry.id, name: entry.name, input: entry.input }],
        },
      };
    case "tool_result":
      return {
        ...base,
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: entry.id, content: entry.output }],
        },
      };
  }
}

export function transcriptEntries(lines: readonly ClaudeLine[]): readonly TranscriptEntry[] {
  return lines.flatMap(entriesOf);
}

export function readTranscript(path: string): readonly TranscriptEntry[] {
  if (!existsSync(path)) return [];
  return transcriptEntries(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => ClaudeLine.parse(JSON.parse(line))),
  );
}
