import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

type ClaudeBlock = {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly tool_use_id?: string;
  readonly content?: string | readonly { readonly type: string; readonly text?: string }[];
};

type ClaudeLine = {
  readonly type: string;
  readonly message?: { readonly role: string; readonly content: string | readonly ClaudeBlock[] };
};

export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

function resultText(content: ClaudeBlock["content"]): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
    .join("\n");
}

function entryOf(block: ClaudeBlock): TranscriptEntry | null {
  if (block.type === "text") return { type: "assistant", text: block.text ?? "" };
  if (block.type === "tool_use") {
    return { type: "tool_use", id: block.id ?? "", name: block.name ?? "", input: block.input ?? {} };
  }
  if (block.type === "tool_result") {
    return { type: "tool_result", id: block.tool_use_id ?? "", output: resultText(block.content) };
  }
  return null;
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

export function readTranscript(path: string): readonly TranscriptEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => entriesOf(JSON.parse(line) as ClaudeLine));
}
