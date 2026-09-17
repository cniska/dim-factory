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
import { SCHEMA_SQL } from "./schema";
import { applyHookEvents, type DrainReport, drainSpool } from "./spool";

export type SyncReport = {
  claudeTranscripts: number;
  claudeSubagents: number;
  codexRollouts: number;
  filesRead: number;
  orphanSubagents: string[];
  failures: { path: string; error: string }[];
  hooks: DrainReport;
  history: HistoryReport;
  git: GitReport;
  repoFiles: RepoFileReport;
  guidance: GuidanceReport;
  chain: HandoffLinkReport;
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
    hooks: drainSpool(db, env),
    history: { read: 0, orphans: 0 },
    git: { repos: 0, commits: 0, files: 0 },
    repoFiles: { repos: 0, files: 0 },
    guidance: { files: 0, versions: 0 },
    chain: { pasted: 0, linked: 0 },
  };

  const run = (spec: FileSpec): void => {
    try {
      if (ingester.ingestFile(spec).read) report.filesRead += 1;
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

/**
 * Everything here is re-read from the source files. `hook_event` is deliberately
 * not cleared: it is the one table with no source to re-read from.
 */
export function rebuild(db: Database, env: Env = process.env): SyncReport {
  db.transaction(() => {
    // The search index holds no text of its own and reads it back through
    // message.rowid, so clearing message row by row would have its triggers ask
    // the index to forget entries an older schema never gave it. Dropping it
    // first is also how the index arrives for a database built before it existed.
    db.run("DROP TRIGGER IF EXISTS message_fts_insert");
    db.run("DROP TRIGGER IF EXISTS message_fts_delete");
    db.run("DROP TRIGGER IF EXISTS message_fts_update");
    db.run("DROP TABLE IF EXISTS message_fts");
    db.run("DELETE FROM skill_load");
    db.run("DELETE FROM tool_call");
    db.run("DELETE FROM orphan_prompt");
    db.run("DELETE FROM session_cost_reported");
    db.run("DELETE FROM turn");
    db.run("DELETE FROM usage");
    db.run("DELETE FROM message");
    // Dropped rather than emptied, for the same reason as the git tables below:
    // a column added to session cannot appear in a table that already exists,
    // and every row in it is read back from the transcripts. Its dependents are
    // emptied above, so nothing references it by the time it goes.
    db.run("DROP TABLE IF EXISTS session");
    // Dropped rather than emptied, like the search index above: these are read
    // back from git in full, and a column added to one of them cannot appear in
    // a table that already exists.
    db.run("DROP TABLE IF EXISTS guidance_version");
    db.run("DROP TABLE IF EXISTS commit_file");
    db.run("DROP TABLE IF EXISTS git_command");
    db.run("DROP TABLE IF EXISTS repo_file");
    db.run("DROP TABLE IF EXISTS repo_commit");
    db.run("DELETE FROM source_file");
    db.run(SCHEMA_SQL);
  })();
  return sync(db, env);
}
