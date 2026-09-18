import type { Database } from "bun:sqlite";
import { listClaudeSubagents, listClaudeTranscripts } from "./claude-source";
import { listCodexRollouts, readCodexTitles } from "./codex-source";
import { type GitReport, ingestCommits } from "./git-ingest";
import { type GuidanceReport, ingestGuidance } from "./guidance";
import { type HandoffLinkReport, linkHandoffs } from "./handoff";
import { type HistoryReport, ingestHistory } from "./history";
import { createIngester, type FileSpec } from "./ingest";
import type { Env } from "./paths";
import { indexRepoFiles, type RepoFileReport } from "./repo-files";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";
import { applyHookEvents, type DrainReport, drainSpool } from "./spool";
import { drainWalk, type WalkReport } from "./walk";

export type SyncReport = {
  claudeTranscripts: number;
  claudeSubagents: number;
  codexRollouts: number;
  filesRead: number;
  orphanSubagents: string[];
  failures: { path: string; error: string }[];
  /** Files with complete lines that were not JSON, and which line each was on. */
  dropped: { path: string; lines: number[] }[];
  hooks: DrainReport;
  history: HistoryReport;
  git: GitReport;
  repoFiles: RepoFileReport;
  guidance: GuidanceReport;
  chain: HandoffLinkReport;
  walk: WalkReport;
};

export function sync(db: Database, env: Env = process.env): SyncReport {
  const ingester = createIngester(db);
  const sessionExists = db.prepare<{ one: number }, [string]>("SELECT 1 AS one FROM session WHERE id = ?");
  const setTitle = db.prepare<void, [string, string]>(
    "UPDATE session SET title = ? WHERE id = ? AND title IS NULL",
  );

  const report: SyncReport = {
    claudeTranscripts: 0,
    claudeSubagents: 0,
    codexRollouts: 0,
    filesRead: 0,
    orphanSubagents: [],
    failures: [],
    dropped: [],
    hooks: drainSpool(db, env),
    history: { read: 0, orphans: 0 },
    git: { repos: 0, commits: 0, files: 0 },
    repoFiles: { repos: 0, files: 0 },
    guidance: { files: 0, versions: 0 },
    chain: { pasted: 0, linked: 0 },
    walk: drainWalk(db, env),
  };

  const run = (spec: FileSpec): void => {
    try {
      const result = ingester.ingestFile(spec);
      if (result.read) report.filesRead += 1;
      if (result.dropped.length > 0) report.dropped.push({ path: spec.path, lines: result.dropped });
    } catch (error) {
      report.failures.push({
        path: spec.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  for (const spec of listClaudeTranscripts(env)) {
    run(spec);
    report.claudeTranscripts += 1;
  }

  // A subagent points at its parent session, so it follows the main pass.
  for (const spec of listClaudeSubagents(env)) {
    if (spec.parentId && !sessionExists.get(spec.parentId)) {
      report.orphanSubagents.push(spec.sessionId);
      spec.parentId = undefined;
    }
    run(spec);
    report.claudeSubagents += 1;
  }

  const titles = readCodexTitles(env);
  for (const spec of listCodexRollouts(env)) {
    run(spec);
    report.codexRollouts += 1;
    const title = titles.get(spec.sessionId);
    if (title) setTitle.run(title, spec.sessionId);
  }

  // After the transcripts, so a hook that fired before its session was read
  // still lands on the session row, and so a prompt is only called an orphan
  // once every transcript that could claim it has been read.
  applyHookEvents(db);
  report.history = ingestHistory(db, env);
  // Last, because which repos to read comes from the session rows just written.
  report.git = ingestCommits(db);
  // Both of these read the repos the commits just named, so neither scans a disk.
  report.repoFiles = indexRepoFiles(db);
  report.guidance = ingestGuidance(db, env);
  // Derived from the messages just written, so it follows every transcript pass.
  report.chain = linkHandoffs(db);
  return report;
}

type CorrectionLabel = {
  message_id: string;
  label: string;
  skill_name: string | null;
  rule: string | null;
  labeled_at: string;
};

/**
 * Everything here is re-read from the source files. Each table is dropped
 * rather than emptied, because `CREATE TABLE IF NOT EXISTS` leaves one that
 * already exists alone, so a column added to it would never appear and every
 * write of that column would throw. They go in dependency order: with foreign
 * keys on, a drop is an implicit delete, and a parent whose children are still
 * there fails.
 *
 * Which tables are left instead, and why, is stated at each of them in
 * `schema.ts`. `correction_label` is the one that is neither: it has no source
 * either, but is dropped with the rest and written back row for row.
 */
export function rebuild(db: Database, env: Env = process.env): SyncReport {
  db.transaction(() => {
    // Read out before the drop because no source can re-read them, and dropped
    // ahead of message because an older database has a foreign key to it that
    // would refuse that drop.
    const labels = db
      .query<CorrectionLabel, []>(
        "SELECT message_id, label, skill_name, rule, labeled_at FROM correction_label",
      )
      .all();
    db.run("DROP TABLE IF EXISTS correction_label");
    // The index is external content over message, so it would be left pointing
    // into a table dropped and refilled below. Its triggers need no drop of
    // their own: they belong to message, and a drop fires none of them.
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
    db.run("DROP TABLE IF EXISTS handoff_link");
    db.run(SCHEMA_SQL);
    const restore = db.prepare<void, [string, string, string | null, string | null, string]>(
      `INSERT INTO correction_label (message_id, label, skill_name, rule, labeled_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of labels) {
      restore.run(row.message_id, row.label, row.skill_name, row.rule, row.labeled_at);
    }
  })();
  const report = sync(db, env);
  db.run("UPDATE schema_version SET version = ?", [SCHEMA_VERSION]);
  return report;
}
