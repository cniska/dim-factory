#!/usr/bin/env bun
// dim — read Claude Code and Codex session records into a local SQLite database.
// No model call happens anywhere below this line.

import { closeDb, openDb } from "./db";
import { installHooks, planHooks } from "./hooks";
import { withLock } from "./lock";
import { dbPath } from "./paths";
import { ensureSpoolDirs } from "./spool";
import { rebuild, type SyncReport, sync } from "./sync";

const USAGE = `usage: dim <command>

  init            create the database and its schema
  sync            read every new byte of both tools' session files
  rebuild         forget every cursor and read all files from the start
  stats           row counts and token totals per tool and model
  install-hooks   show the session hooks to add to both tools' config
                  (--write applies them, after copying each config aside)
`;

function printReport(report: SyncReport): void {
  console.log(
    `claude: ${report.claudeTranscripts} transcripts, ${report.claudeSubagents} subagents; ` +
      `codex: ${report.codexRollouts} rollouts; ${report.filesRead} files with new bytes`,
  );
  const h = report.hooks;
  if (h.applied + h.duplicate + h.unreadable > 0) {
    console.log(
      `hooks: ${h.applied} spooled events applied, ${h.duplicate} already seen, ${h.unreadable} unreadable`,
    );
  }
  if (report.orphanSubagents.length > 0) {
    console.log(`${report.orphanSubagents.length} subagents whose parent session is gone, recorded unlinked`);
  }
  for (const failure of report.failures) {
    console.error(`dim: ${failure.path}: ${failure.error}`);
  }
}

function printStats(): void {
  const db = openDb(dbPath());
  try {
    const counts = db
      .prepare<{ files: number; sessions: number; messages: number; usage_rows: number }, []>(
        `SELECT (SELECT count(*) FROM source_file) AS files,
                (SELECT count(*) FROM session) AS sessions,
                (SELECT count(*) FROM message) AS messages,
                (SELECT count(*) FROM usage) AS usage_rows`,
      )
      .get();
    console.log(
      `${counts?.files ?? 0} files, ${counts?.sessions ?? 0} sessions, ` +
        `${counts?.messages ?? 0} messages, ${counts?.usage_rows ?? 0} usage rows`,
    );
    const rows = db
      .prepare<
        {
          tool: string;
          model: string | null;
          responses: number;
          input: number;
          cache_read: number;
          output: number;
        },
        []
      >(
        `SELECT s.tool, u.model, count(*) AS responses, sum(u.input_tokens) AS input,
                sum(u.cache_read_tokens) AS cache_read, sum(u.output_tokens) AS output
         FROM usage u JOIN session s ON s.id = u.session_id
         GROUP BY s.tool, u.model ORDER BY responses DESC`,
      )
      .all();
    for (const r of rows) {
      console.log(
        `  ${r.tool.padEnd(7)} ${(r.model ?? "(none)").padEnd(26)} ` +
          `${String(r.responses).padStart(7)} responses  in ${r.input}  cache_read ${r.cache_read}  out ${r.output}`,
      );
    }
  } finally {
    closeDb(db);
  }
}

function withDb(fn: (db: ReturnType<typeof openDb>) => SyncReport, forRebuild = false): void {
  withLock(() => {
    const db = openDb(dbPath(), { forRebuild });
    try {
      printReport(fn(db));
    } finally {
      closeDb(db);
    }
  });
}

function printHookPlan(write: boolean): void {
  ensureSpoolDirs();
  const plans = planHooks();
  const missing = plans.filter((p) => !p.present);
  if (missing.length === 0) {
    console.log("hooks: all four session hooks are already installed");
    return;
  }
  for (const plan of missing) {
    console.log(`${plan.configPath}\n  hooks.${plan.event} += ${plan.command}`);
  }
  if (!write) {
    console.log(`\n${missing.length} to add. Re-run with --write to apply.`);
    return;
  }
  const report = installHooks();
  for (const path of report.written) console.log(`wrote ${path}`);
  for (const path of report.backups) console.log(`previous version kept at ${path}`);
}

const command = process.argv[2];
try {
  switch (command) {
    case "init":
      closeDb(openDb(dbPath()));
      break;
    case "sync":
      withDb((db) => sync(db));
      break;
    case "rebuild":
      withDb((db) => rebuild(db), true);
      break;
    case "stats":
      printStats();
      break;
    case "install-hooks":
      printHookPlan(process.argv.includes("--write"));
      break;
    default:
      console.log(USAGE);
      process.exit(1);
  }
} catch (error) {
  console.error(`dim: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
