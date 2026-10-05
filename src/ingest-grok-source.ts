import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
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

const SummaryFile = z.looseObject({
  info: z.looseObject({ id: z.string().optional(), cwd: z.string().optional() }).optional(),
  generated_title: z.string().nullish(),
  head_branch: z.string().nullish(),
  parent_session_id: z.string().nullish(),
  created_at: z.string().nullish(),
  agent_name: z.string().nullish(),
});

function nonEmpty(value: string | null | undefined): string | undefined {
  return value != null && value !== "" ? value : undefined;
}

function readSummaryFile(path: string): z.infer<typeof SummaryFile> | undefined {
  try {
    const parsed = SummaryFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readGrokSummary(sessionDir: string): GrokSummary | undefined {
  const path = join(sessionDir, "summary.json");
  if (!existsSync(path)) return undefined;
  const file = readSummaryFile(path);
  if (!file) return undefined;
  const id = nonEmpty(file.info?.id) ?? basename(sessionDir);
  const cwd = nonEmpty(file.info?.cwd);
  return {
    id,
    cwd,
    project: projectOf(cwd),
    gitBranch: nonEmpty(file.head_branch),
    title: nonEmpty(file.generated_title),
    parentId: nonEmpty(file.parent_session_id),
    agentType: nonEmpty(file.agent_name),
    startedAt: nonEmpty(file.created_at),
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
