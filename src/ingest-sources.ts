import type { FileSpec } from "./ingest";
import { listClaudeSubagents, listClaudeTranscripts } from "./ingest-claude-source";
import { codexTitlesPath, listCodexRollouts, readCodexTitles } from "./ingest-codex-source";
import { listGrokSessions } from "./ingest-grok-source";
import type { Tool } from "./ingest-tools";
import type { Env } from "./paths";

export type SessionSource = {
  tool: Tool;
  list(env: Env): FileSpec[];
  titles?: { path(env: Env): string; read(path: string): ReadonlyMap<string, string> };
};

export const SESSION_SOURCES: readonly SessionSource[] = [
  {
    tool: "claude",
    list: (env) => [...listClaudeTranscripts(env), ...listClaudeSubagents(env)],
  },
  {
    tool: "codex",
    list: listCodexRollouts,
    titles: { path: codexTitlesPath, read: readCodexTitles },
  },
  {
    tool: "grok",
    list: listGrokSessions,
  },
];
