import type { Capability } from "./capabilities";

export type HarnessRequest = {
  cwd: string;
  brief: string;
  model: string;
  capabilities: readonly Capability[];
  env: Readonly<Record<string, string>>;
  outputSchema?: string;
};

export type HarnessEvent =
  | { type: "run.started"; providerSessionId?: string }
  | { type: "turn.started" }
  | { type: "message"; role: "assistant"; text: string }
  | { type: "tool.started"; name: string; toolId?: string }
  | { type: "tool.output"; name: string; text: string; toolId?: string }
  | { type: "tool.completed"; name: string; exitCode?: number; toolId?: string }
  | { type: "diagnostic"; level: "info" | "warning" | "error"; message: string }
  | { type: "run.completed"; output?: string }
  | { type: "run.failed"; reason: string };

export type HarnessRun = {
  events: AsyncIterable<HarnessEvent>;
  cancel(): void;
};

export type HarnessAdapter = {
  name: string;
  start(request: HarnessRequest): Promise<HarnessRun>;
  resume(providerSessionId: string, request: HarnessRequest): Promise<HarnessRun>;
};
