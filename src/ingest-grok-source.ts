import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Glob } from "bun";
import type { SourceFile } from "./ingest";
import { parseGrokChunk } from "./ingest-parse-grok";
import { projectOf, type SessionFacts } from "./ingest-session-records";
import { type Env, grokDir } from "./paths";

type GrokSummary = {
  id: string;
  cwd?: string;
  project?: string;
  gitBranch?: string;
  title?: string;
  parentId?: string;
  agentType?: string;
  startedAt?: string;
};

type SummaryFile = {
  info?: { id?: string; cwd?: string };
  generated_title?: string;
  head_branch?: string;
  parent_session_id?: string;
  created_at?: string;
  agent_name?: string;
};

function nonEmpty(value: string | undefined): string | undefined {
  return value != null && value !== "" ? value : undefined;
}

function readGrokSummary(sessionDir: string): GrokSummary | undefined {
  const path = join(sessionDir, "summary.json");
  if (!existsSync(path)) return undefined;
  let parsed: SummaryFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as SummaryFile;
  } catch {
    return undefined;
  }
  const id = nonEmpty(parsed.info?.id) ?? basename(sessionDir);
  const cwd = nonEmpty(parsed.info?.cwd);
  return {
    id,
    cwd,
    project: projectOf(cwd),
    gitBranch: nonEmpty(parsed.head_branch),
    title: nonEmpty(parsed.generated_title),
    parentId: nonEmpty(parsed.parent_session_id),
    agentType: nonEmpty(parsed.agent_name),
    startedAt: nonEmpty(parsed.created_at),
  };
}

function summaryFacts(summary: GrokSummary | undefined): SessionFacts[] {
  if (!summary) return [];
  return [
    {
      ts: summary.startedAt,
      cwd: summary.cwd,
      project: summary.project,
      gitBranch: summary.gitBranch,
      title: summary.title,
    },
  ];
}

export function listGrokSessions(env: Env = process.env): SourceFile[] {
  const root = join(grokDir(env), "sessions");
  if (!existsSync(root)) return [];
  const specs: SourceFile[] = [];
  for (const path of new Glob("*/*/updates.jsonl").scanSync({ cwd: root, absolute: true })) {
    const sessionDir = dirname(path);
    const summary = readGrokSummary(sessionDir);
    const facts = summaryFacts(summary);
    specs.push({
      path,
      kind: "transcript",
      sessionId: summary?.id ?? basename(sessionDir),
      parentId: summary?.parentId,
      agentType: summary?.agentType,
      parse: (lines, first) => {
        const parsed = parseGrokChunk(lines, first);
        parsed.session.push(...facts);
        return parsed;
      },
    });
  }
  return orderParents(specs.sort((a, b) => a.path.localeCompare(b.path)));
}

function orderParents(specs: SourceFile[]): SourceFile[] {
  const ids = new Set(specs.map((spec) => spec.sessionId));
  const remaining = [...specs];
  const ordered: SourceFile[] = [];
  const placed = new Set<string>();
  while (remaining.length > 0) {
    const ready = remaining.filter(
      (spec) => spec.parentId == null || !ids.has(spec.parentId) || placed.has(spec.parentId),
    );
    if (ready.length === 0) return ordered.concat(remaining);
    for (const spec of ready) {
      placed.add(spec.sessionId);
      ordered.push(spec);
    }
    for (const spec of ready) remaining.splice(remaining.indexOf(spec), 1);
  }
  return ordered;
}
