import type { Database } from "bun:sqlite";
import { isRefusal } from "./coded-error";
import { writeTransaction } from "./db";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";
import { createIngester, type FileSpec } from "./ingest";
import { type GitReport, ingestCommits, repoRoots } from "./ingest-git";
import { SESSION_SOURCES, type SessionSource } from "./ingest-sources";
import { applyHookEvents, type DrainReport, drainSpool } from "./ingest-spool";
import { TOOLS, type Tool } from "./ingest-tools";
import type { Env } from "./paths";
import { indexRepoFiles, type RepoFileReport } from "./repo-files";

export type SyncReport = {
  sources: { tool: Tool; files: number }[];
  filesRead: number;
  orphanSubagents: string[];
  failures: { path: string; error: string }[];
  dropped: { path: string; lines: number[] }[];
  hooks: DrainReport;
  git: GitReport;
  repoFiles: RepoFileReport;
};

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
    git: { repos: 0, commits: 0, files: 0 },
    repoFiles: { repos: 0, files: 0 },
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

  for (const tool of TOOLS) {
    const source = SESSION_SOURCES[tool];
    const files = source.list(env);
    const titles = titlesOf(source);
    for (const file of files) {
      if (file.parentId && !sessionExists.get(file.parentId)) {
        report.orphanSubagents.push(file.sessionId);
        file.parentId = undefined;
      }
      run({ ...file, tool });
      const title = titles?.get(file.sessionId);
      if (title) setTitle.run(title, file.sessionId);
    }
    report.sources.push({ tool, files: files.length });
  }

  applyHookEvents(db);
  const failRefused = (path: string, error: unknown): void => {
    if (!isRefusal(error)) throw error;
    fail(path, error);
  };
  const roots = repoRoots(db, failRefused, env);
  report.git = ingestCommits(db, roots, failRefused);
  report.repoFiles = indexRepoFiles(db, roots, failRefused);
  return report;
}

const HOOK_EVENT_COLUMNS = "tool, session_id, event, ts, harness_pid, reason, cwd";

function tablesWhere(db: Database, condition: string): readonly string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND ${condition}`,
    )
    .all()
    .map((row) => row.name);
}

function dropEveryTable(db: Database): void {
  for (const name of tablesWhere(db, "sql LIKE 'CREATE VIRTUAL TABLE%'")) db.run(`DROP TABLE "${name}"`);
  for (const name of tablesWhere(db, "1")) db.run(`DROP TABLE "${name}"`);
}

export function rebuild(db: Database, env: Env = process.env): SyncReport {
  db.run("PRAGMA foreign_keys = OFF");
  try {
    writeTransaction(db, () => {
      db.run(`CREATE TEMP TABLE kept_hook_event AS SELECT ${HOOK_EVENT_COLUMNS} FROM hook_event`);
      dropEveryTable(db);
      db.run(SCHEMA_SQL);
      db.run(
        `INSERT OR IGNORE INTO hook_event (${HOOK_EVENT_COLUMNS}) SELECT ${HOOK_EVENT_COLUMNS} FROM kept_hook_event`,
      );
      db.run("DROP TABLE kept_hook_event");
    });
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
  const report = sync(db, env);
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return report;
}
