import type { Database } from "bun:sqlite";
import { writeTransaction } from "./db";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";
import { type GuidanceReport, ingestGuidance } from "./guidance";
import { drainWalk, type WalkReport } from "./guidance-walk";
import { createIngester, type FileSpec } from "./ingest";
import { type GitReport, ingestCommits } from "./ingest-git";
import { type HistoryReport, ingestHistory } from "./ingest-history";
import { SESSION_SOURCES, type SessionSource } from "./ingest-sources";
import { applyHookEvents, type DrainReport, drainSpool } from "./ingest-spool";
import type { Tool } from "./ingest-tools";
import type { Env } from "./paths";
import { indexRepoFiles, type RepoFileReport } from "./repo-files";

export type SyncReport = {
  sources: { tool: Tool; files: number }[];
  filesRead: number;
  orphanSubagents: string[];
  failures: { path: string; error: string }[];
  dropped: { path: string; lines: number[] }[];
  hooks: DrainReport;
  history: HistoryReport;
  git: GitReport;
  repoFiles: RepoFileReport;
  guidance: GuidanceReport;
  walk: WalkReport;
};

export type RebuildReport = SyncReport & { retired: string[] };

export function sync(db: Database, env: Env = process.env): SyncReport {
  const ingester = createIngester(db);
  const sessionExists = db.prepare<{ one: number }, [string]>("SELECT 1 AS one FROM session WHERE id = ?");
  const setTitle = db.prepare<void, [string, string]>(
    "UPDATE session SET title = ? WHERE id = ? AND title IS NULL",
  );

  const report: SyncReport = {
    sources: [],
    filesRead: 0,
    orphanSubagents: [],
    failures: [],
    dropped: [],
    hooks: drainSpool(db, env),
    history: { read: 0, orphans: 0 },
    git: { repos: 0, commits: 0, files: 0 },
    repoFiles: { repos: 0, files: 0 },
    guidance: { files: 0, versions: 0 },
    walk: drainWalk(db, env),
  };

  const fail = (path: string, error: unknown): void => {
    report.failures.push({ path, error: error instanceof Error ? error.message : String(error) });
  };

  const run = (spec: FileSpec): void => {
    try {
      const result = ingester.ingestFile(spec);
      if (result.read) report.filesRead += 1;
      if (result.dropped.length > 0) report.dropped.push({ path: spec.path, lines: result.dropped });
    } catch (error) {
      fail(spec.path, error);
    }
  };

  const titlesOf = (source: SessionSource): ReadonlyMap<string, string> | undefined => {
    if (!source.titles) return undefined;
    const path = source.titles.path(env);
    try {
      return source.titles.read(path);
    } catch (error) {
      fail(path, error);
      return undefined;
    }
  };

  for (const source of SESSION_SOURCES) {
    const specs = source.list(env);
    const titles = titlesOf(source);
    for (const spec of specs) {
      if (spec.parentId && !sessionExists.get(spec.parentId)) {
        report.orphanSubagents.push(spec.sessionId);
        spec.parentId = undefined;
      }
      run(spec);
      const title = titles?.get(spec.sessionId);
      if (title) setTitle.run(title, spec.sessionId);
    }
    report.sources.push({ tool: source.tool, files: specs.length });
  }

  applyHookEvents(db);
  report.history = ingestHistory(db, env);
  report.git = ingestCommits(db);
  report.repoFiles = indexRepoFiles(db);
  report.guidance = ingestGuidance(db, env);
  return report;
}

type HookEvent = {
  tool: string;
  session_id: string;
  event: string;
  ts: string;
  harness_pid: number | null;
  source: string | null;
  reason: string | null;
  model: string | null;
  cwd: string | null;
  payload: string;
};

function dropRetiredTables(db: Database): string[] {
  const named = (pattern: RegExp): string[] =>
    [...SCHEMA_SQL.matchAll(pattern)].map((match) => match[1] as string);
  const defined = new Set(named(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/g));
  const virtual = named(/CREATE VIRTUAL TABLE IF NOT EXISTS (\w+)/g);
  const retired = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
    .filter((name) => !defined.has(name) && !name.startsWith("sqlite_"))
    .filter((name) => !virtual.some((table) => name.startsWith(`${table}_`)));
  db.run("PRAGMA defer_foreign_keys = ON");
  for (const name of retired) db.run(`DROP TABLE IF EXISTS ${name}`);
  db.run("PRAGMA defer_foreign_keys = OFF");
  return retired;
}

export function rebuild(db: Database, env: Env = process.env): RebuildReport {
  let retired: string[] = [];
  writeTransaction(db, () => {
    retired = dropRetiredTables(db);
    const hasHarnessPid = db
      .query<{ name: string }, []>("PRAGMA table_info(hook_event)")
      .all()
      .some((column) => column.name === "harness_pid");
    const hookEvents = db
      .query<HookEvent, []>(
        `SELECT tool, session_id, event, ts, ${hasHarnessPid ? "harness_pid" : "NULL AS harness_pid"}, source, reason, model, cwd, payload FROM hook_event`,
      )
      .all();
    db.run("DROP TABLE IF EXISTS hook_event");
    db.run("DROP TABLE IF EXISTS message_fts");
    db.run("DROP TABLE IF EXISTS git_command");
    db.run("DROP TABLE IF EXISTS skill_load");
    db.run("DROP TABLE IF EXISTS tool_call");
    db.run("DROP TABLE IF EXISTS orphan_prompt");
    db.run("DROP TABLE IF EXISTS session_cost_reported");
    db.run("DROP TABLE IF EXISTS turn");
    db.run("DROP TABLE IF EXISTS usage");
    db.run("DROP TABLE IF EXISTS message");
    db.run("DROP TABLE IF EXISTS session");
    db.run("DROP TABLE IF EXISTS source_file");
    db.run("DROP TABLE IF EXISTS guidance_version");
    db.run("DROP TABLE IF EXISTS commit_file");
    db.run("DROP TABLE IF EXISTS repo_file");
    db.run("DROP TABLE IF EXISTS repo_commit");
    db.run(SCHEMA_SQL);
    const restoreHook = db.prepare<
      void,
      [
        string,
        string,
        string,
        string,
        number | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
      ]
    >(
      `INSERT INTO hook_event (tool, session_id, event, ts, harness_pid, source, reason, model, cwd, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of hookEvents) {
      restoreHook.run(
        row.tool,
        row.session_id,
        row.event,
        row.ts,
        row.harness_pid,
        row.source,
        row.reason,
        row.model,
        row.cwd,
        row.payload,
      );
    }
  });
  const report = sync(db, env);
  db.run("UPDATE schema_version SET version = ?", [SCHEMA_VERSION]);
  return { ...report, retired };
}
