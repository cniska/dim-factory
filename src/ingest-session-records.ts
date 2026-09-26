import type { SkillLoadRow } from "./ingest-skill-load";

export type SessionFacts = {
  ts?: string;
  cwd?: string;
  project?: string;
  gitBranch?: string;
  cliVersion?: string;
  entrypoint?: string;
  model?: string;
  title?: string;
  extra?: string;
};

export type MessageRow = {
  id: string;
  ts: string;
  role: "user" | "assistant";
  model?: string;
  turnId?: string;
  promptSource?: string;
  originKind?: string;
  isMeta: boolean;
  isSkillBody: boolean;
  attributionSkill?: string;
  stopReason?: string;
  interruptedMessageId?: string;
  denialKind?: string;
  userFeedback?: string;
  text?: string;
  srcLine: number;
  extra?: string;
};

export type UsageRow = {
  responseId: string;
  ts: string;
  model?: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  attributionSkill?: string;
  messageId?: string;
  extra?: string;
};

export type TurnRow = {
  turnId: string;
  tsStart?: string;
  tsEnd: string;
  durationMs?: number;
  messageCount?: number;
  status: string;
  model?: string;
  timeToFirstTokenMs?: number;
};

export type CostRow = {
  reportedBy: string;
  totalCostUsd?: number;
  modelUsage: string;
  hasUnknownModelCost?: boolean;
  ts?: string;
};

export type ToolCallRow = {
  id: string;
  messageId?: string;
  model?: string;
  attributionSkill?: string;
  tsCall?: string;
  tsResult?: string;
  toolName: string;
  skillName?: string;
  filePath?: string;
  command?: string;
  isError?: boolean;
  interrupted?: boolean;
  exitCode?: number;
  durationMs?: number;
  gitOperation?: string;
  resultBytes?: number;
  srcLineCall?: number;
  srcLineResult?: number;
  extra?: string;
};

export type ParsedChunk = {
  session: SessionFacts[];
  messages: MessageRow[];
  usage: UsageRow[];
  turns: TurnRow[];
  costs: CostRow[];
  toolCalls: ToolCallRow[];
  skillLoads: SkillLoadRow[];
  dropped: number[];
  cursorState?: string;
};

const WORKTREE_MARKER = "/.claude/worktrees/";

export function projectOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const at = cwd.indexOf(WORKTREE_MARKER);
  return at === -1 ? cwd : cwd.slice(0, at);
}

export function jsonOrUndefined(value: Record<string, unknown>): string | undefined {
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined && v !== null) kept[k] = v;
  }
  return Object.keys(kept).length > 0 ? JSON.stringify(kept) : undefined;
}
