import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Glob } from "bun";
import type { SourceFile } from "./ingest";
import { CodexState, parseCodexChunk } from "./ingest-parse-codex";
import { codexDir, type Env } from "./paths";

const ROLLOUT_NAME = /^rollout-[0-9T:-]+-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/;

export function threadIdOf(path: string): string | undefined {
  return ROLLOUT_NAME.exec(basename(path, ".jsonl"))?.[1];
}

function readState(raw: string | null): CodexState {
  if (!raw) return {};
  try {
    const parsed = CodexState.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function listCodexRollouts(env: Env = process.env): SourceFile[] {
  const root = codexDir(env);
  const specs: SourceFile[] = [];
  for (const dir of [join(root, "sessions"), join(root, "archived_sessions")]) {
    if (!existsSync(dir)) continue;
    for (const path of new Glob("**/rollout-*.jsonl").scanSync({ cwd: dir, absolute: true })) {
      const threadId = threadIdOf(path);
      if (!threadId) continue;
      specs.push({
        path,
        kind: "rollout",
        sessionId: threadId,
        parse: (lines, first, state) => parseCodexChunk(lines, first, threadId, readState(state)),
      });
    }
  }
  return specs.sort((a, b) => a.path.localeCompare(b.path));
}

export function codexTitlesPath(env: Env = process.env): string {
  return join(codexDir(env), "state_5.sqlite");
}

export function readCodexTitles(statePath: string): Map<string, string> {
  const titles = new Map<string, string>();
  if (!existsSync(statePath)) return titles;
  const db = new Database(`file:${statePath}?immutable=1`, { readonly: true });
  try {
    for (const row of db
      .prepare<{ id: string; title: string | null }, []>("SELECT id, title FROM threads")
      .all()) {
      if (row.title) titles.set(row.id, row.title);
    }
  } finally {
    db.close();
  }
  return titles;
}
