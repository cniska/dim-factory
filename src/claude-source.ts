import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Glob } from "bun";
import type { FileSpec } from "./ingest";
import { listInstalledSkills } from "./installed-skills";
import { parseClaudeChunk } from "./parse-claude";
import { claudeProjectsDir, type Env } from "./paths";

function parserFor(env: Env) {
  // Read once per listing rather than per file.
  const known = listInstalledSkills(env);
  return (lines: string[], firstLineNumber: number) => parseClaudeChunk(lines, firstLineNumber, known);
}

/** ~/.claude/projects/<slug>/<session>.jsonl */
export function listClaudeTranscripts(env: Env = process.env): FileSpec[] {
  const root = claudeProjectsDir(env);
  if (!existsSync(root)) return [];
  const specs: FileSpec[] = [];
  const parse = parserFor(env);
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

/**
 * An agent id repeats across parent sessions — six do in this corpus — so it is
 * the pair that names a run, and keying on the id alone makes two different
 * subagents one row and hands the second the first's read cursor. The agent id
 * leads so that a prefix search still finds it and the short form still reads
 * as the id a tool result names.
 */
export function subagentId(agentId: string, parentId: string): string {
  return `${agentId}@${parentId}`;
}

/** ~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl */
export function listClaudeSubagents(env: Env = process.env): FileSpec[] {
  const root = claudeProjectsDir(env);
  if (!existsSync(root)) return [];
  const specs: FileSpec[] = [];
  const parse = parserFor(env);
  for (const path of new Glob("*/*/subagents/*.jsonl").scanSync({ cwd: root, absolute: true })) {
    const parentId = basename(dirname(dirname(path)));
    specs.push({
      path,
      tool: "claude",
      kind: "subagent",
      sessionId: subagentId(basename(path, ".jsonl").replace(/^agent-/, ""), parentId),
      parentId,
      agentType: agentTypeOf(path),
      parse,
    });
  }
  return specs.sort((a, b) => a.path.localeCompare(b.path));
}
