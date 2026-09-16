import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Glob } from "bun";
import type { FileSpec } from "./ingest";
import { parseClaudeChunk } from "./parse-claude";
import { claudeProjectsDir, type Env } from "./paths";

function parse(lines: string[], firstLineNumber: number) {
  return parseClaudeChunk(lines, firstLineNumber);
}

/** ~/.claude/projects/<slug>/<session>.jsonl */
export function listClaudeTranscripts(env: Env = process.env): FileSpec[] {
  const root = claudeProjectsDir(env);
  if (!existsSync(root)) return [];
  const specs: FileSpec[] = [];
  for (const path of new Glob("*/*.jsonl").scanSync({ cwd: root, absolute: true })) {
    specs.push({
      path,
      tool: "claude",
      kind: "transcript",
      sessionId: basename(path, ".jsonl"),
      parse,
    });
  }
  return specs.sort((a, b) => a.path.localeCompare(b.path));
}

function agentTypeOf(path: string): string | undefined {
  const meta = join(dirname(path), `${basename(path, ".jsonl")}.meta.json`);
  if (!existsSync(meta)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(meta, "utf8")) as { agentType?: string };
    return parsed.agentType || undefined;
  } catch {
    return undefined;
  }
}

/** ~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl */
export function listClaudeSubagents(env: Env = process.env): FileSpec[] {
  const root = claudeProjectsDir(env);
  if (!existsSync(root)) return [];
  const specs: FileSpec[] = [];
  for (const path of new Glob("*/*/subagents/*.jsonl").scanSync({ cwd: root, absolute: true })) {
    specs.push({
      path,
      tool: "claude",
      kind: "subagent",
      sessionId: basename(path, ".jsonl").replace(/^agent-/, ""),
      parentId: basename(dirname(dirname(path))),
      agentType: agentTypeOf(path),
      parse,
    });
  }
  return specs.sort((a, b) => a.path.localeCompare(b.path));
}
