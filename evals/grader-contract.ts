import type { ToolCall } from "./transcript";

export type Run = {
  readonly toolCalls: readonly ToolCall[];
  readonly workspace: string;
  readonly tmp: string;
};

export type Verdict = { readonly pass: boolean; readonly reason: string };

export type Grader = { readonly name: string; readonly grade: (run: Run) => Verdict };
