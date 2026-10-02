import type { SourceFile } from "./ingest";
import { listClaudeSubagents, listClaudeTranscripts } from "./ingest-claude-source";
import { codexTitlesPath, listCodexRollouts, readCodexTitles } from "./ingest-codex-source";
import { listGrokSessions } from "./ingest-grok-source";
import { listPiSessions } from "./ingest-pi-source";
import type { Tool } from "./ingest-tools";
import { type Env, ompSessionsDir, piSessionsDir } from "./paths";

export type SessionSource = {
  list(env: Env): SourceFile[];
  titles?: { path(env: Env): string; read(path: string): ReadonlyMap<string, string> };
};

export const SESSION_SOURCES: Readonly<Record<Tool, SessionSource>> = {
  claude: { list: (env) => [...listClaudeTranscripts(env), ...listClaudeSubagents(env)] },
  codex: { list: listCodexRollouts, titles: { path: codexTitlesPath, read: readCodexTitles } },
  grok: { list: listGrokSessions },
  pi: { list: (env) => listPiSessions(piSessionsDir(env)) },
  omp: { list: (env) => listPiSessions(ompSessionsDir(env)) },
};
