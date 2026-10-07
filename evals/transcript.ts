import { z } from "zod";

export type ToolResult = { readonly isError: boolean; readonly text: string };

export type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly result: ToolResult | null;
};

const ToolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const ResultText = z.union([z.string(), z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))]);

const ToolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: ResultText,
});

const Line = z.looseObject({ message: z.looseObject({ content: z.unknown() }).optional() });

const textOf = (content: z.infer<typeof ResultText>) =>
  typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");

export function toolCallsOf(lines: readonly string[]): readonly ToolCall[] {
  const calls: ToolCall[] = [];
  const results = new Map<string, ToolResult>();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const content = Line.parse(JSON.parse(line)).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const use = ToolUse.safeParse(block);
      if (use.success) calls.push({ id: use.data.id, name: use.data.name, input: use.data.input, result: null });
      const result = ToolResultBlock.safeParse(block);
      if (result.success) {
        results.set(result.data.tool_use_id, {
          isError: result.data.is_error ?? false,
          text: textOf(result.data.content),
        });
      }
    }
  }
  return calls.map((call) => ({ ...call, result: results.get(call.id) ?? null }));
}
