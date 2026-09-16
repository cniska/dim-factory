// What a parser produces from one source line. Both tools' parsers emit these,
// and the ingester knows nothing else about either format.

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
  /** Claude names one API response with the same id it gives the message. */
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

/** Cost as the tool computed it. Nothing here derives a dollar figure. */
export type CostRow = {
  reportedBy: string;
  totalCostUsd?: number;
  modelUsage: string;
  hasUnknownModelCost?: boolean;
  ts?: string;
};

/**
 * Emitted twice for one call: once from the record that issued it and once from
 * the record that returned, which the ingester merges on `id`.
 */
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
  /** Size of what the tool returned. The content itself is never stored. */
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
  /** Parser state to resume with when the next chunk of this file is read. */
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
