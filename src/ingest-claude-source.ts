import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Glob } from "bun";
import type { SourceFile } from "./ingest";
import { parseClaudeChunk } from "./ingest-parse-claude";
import { claudeProjectsDir, type Env, workersDir } from "./paths";
import { listInstalledSkills } from "./skill-installed";

function parserFor(env: Env) {
  const known = listInstalledSkills(env);
  return (lines: string[], firstLineNumber: number) => parseClaudeChunk(lines, firstLineNumber, known);
}

function transcriptsUnder(root: string, pattern: string, env: Env): SourceFile[] {
  if (!existsSync(root)) return [];
  const parse = parserFor(env);
  const specs: SourceFile[] = [];
  for (const path of new Glob(pattern).scanSync({ cwd: root, absolute: true })) {
    specs.push({
      path,
      kind: "transcript",
      sessionId: basename(path, ".jsonl"),
      parse,
    });
  }
  return specs.sort((a, b) => a.path.localeCompare(b.path));
}

export function listClaudeTranscripts(env: Env = process.env): SourceFile[] {
  return transcriptsUnder(claudeProjectsDir(env), "*/*.jsonl", env);
}

export function listWorkerTranscripts(env: Env = process.env): SourceFile[] {
  return transcriptsUnder(workersDir(env), "*/sessions/*.jsonl", env);
}

export function listClaudeSessions(env: Env = process.env): SourceFile[] {
  const transcripts = listClaudeTranscripts(env);
  const held = new Set(transcripts.map((file) => file.sessionId));
  const copies = listWorkerTranscripts(env).filter((copy) => !held.has(copy.sessionId));
  return [...transcripts, ...copies, ...listClaudeSubagents(env)];
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

export function subagentId(agentId: string, parentId: string): string {
  return `${agentId}@${parentId}`;
}

export function listClaudeSubagents(env: Env = process.env): SourceFile[] {
  const root = claudeProjectsDir(env);
  if (!existsSync(root)) return [];
  const specs: SourceFile[] = [];
  const parse = parserFor(env);
  for (const path of new Glob("*/*/subagents/*.jsonl").scanSync({ cwd: root, absolute: true })) {
    const parentId = basename(dirname(dirname(path)));
    specs.push({
      path,
      kind: "subagent",
      sessionId: subagentId(basename(path, ".jsonl").replace(/^agent-/, ""), parentId),
      parentId,
      agentType: agentTypeOf(path),
      parse,
    });
  }
  return specs.sort((a, b) => a.path.localeCompare(b.path));
}
