#!/usr/bin/env bun
// dim — read Claude Code and Codex session records into a local SQLite database.
// No model call happens anywhere below this line.

import { AGENT_LABEL, installAgent, planAgent } from "./agent";
import { closeDb, openDb } from "./db";
import { installHooks, planHooks } from "./hooks";
import { withLock } from "./lock";
import { dbPath } from "./paths";
import { findQuery, QUERIES } from "./queries";
import { openReadOnly } from "./read-db";
import { renderTable } from "./render";
import { DEFAULT_WINDOW, windowFromArgs } from "./since";
import { installSkill, planSkill } from "./skill";
import { ensureSpoolDirs } from "./spool";
import { rebuild, type SyncReport, sync } from "./sync";

const USAGE = `usage: dim <command>

  init            create the database and its schema
  sync            read every new byte of both tools' session files
  rebuild         forget every cursor and read all files from the start
  stats           row counts and token totals per tool and model
  install-hooks   show the session hooks to add to both tools' config
                  (--write applies them, after copying each config aside)
  install-agent   show the launchd agent that syncs every 15 minutes
                  (--write writes the plist; load it with launchctl)
  install-skill   show where the df-sessions skill would be linked for agents
                  (--write creates the link, moving anything there aside)
  q <name> [arg]  ask the database a named question (q list names them; --json)
                  covers the last ${DEFAULT_WINDOW}; --since <n>d|YYYY-MM-DD or --all to widen
  label <id> <correction|clarification|not_correction> [--rule "..."]
                  record your judgement on one candidate correction
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
  if (report.git.commits > 0) {
    console.log(
      `git: ${report.git.commits} commits touching ${report.git.files} files, from ${report.git.repos} repos`,
    );
  }
  if (report.guidance.versions > 0) {
    console.log(`guidance: ${report.guidance.versions} versions of ${report.guidance.files} rules files`);
  }
  if (report.history.orphans > 0) {
    console.log(
      `history: ${report.history.orphans} prompts from sessions with no transcript, of ${report.history.read} read`,
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

function printAgentPlan(write: boolean): void {
  const plan = planAgent();
  if (plan.unchanged) {
    console.log(`agent: ${plan.path} is already up to date`);
    return;
  }
  if (!write) {
    console.log(`${plan.path}\n\n${plan.contents}`);
    console.log("Re-run with --write to write it.");
    return;
  }
  installAgent();
  console.log(`wrote ${plan.path}`);
  console.log(`load it with: launchctl bootstrap gui/$(id -u) ${plan.path}`);
  console.log(`remove it with: launchctl bootout gui/$(id -u)/${AGENT_LABEL}`);
}

function printSkillPlan(write: boolean): void {
  const plans = planSkill();
  const pending = plans.filter((p) => p.state !== "linked");
  if (pending.length === 0) {
    console.log(`skill: already linked for every tool (${plans.map((p) => p.link).join(", ")})`);
    return;
  }
  for (const plan of pending) {
    console.log(`${plan.link} -> ${plan.target}`);
    if (plan.state === "occupied") console.log("  something else is at that name; it would be moved aside");
  }
  if (!write) {
    console.log(`\n${pending.length} to link. Re-run with --write to apply.`);
    return;
  }
  installSkill();
  for (const plan of pending) {
    if (plan.state === "occupied") console.log(`previous version kept at ${plan.link}.dim-backup`);
    console.log(`linked ${plan.link}`);
  }
}

/**
 * The one write a reader makes. Nothing derives a correction automatically —
 * whether a prompt told the agent it was wrong is the owner's call, not a rule's.
 */
function runLabel(args: string[]): void {
  const [messageId, label] = args;
  const ruleAt = args.indexOf("--rule");
  const rule = ruleAt === -1 ? null : (args[ruleAt + 1] ?? null);
  if (!messageId || !label) {
    console.error('usage: dim label <message-id> <correction|clarification|not_correction> [--rule "..."]');
    process.exit(1);
  }
  const db = openDb(dbPath());
  try {
    const found = db.prepare("SELECT id FROM message WHERE id = ?").get(messageId);
    if (!found) {
      console.error(`dim: no message ${messageId}`);
      process.exit(1);
    }
    db.run(
      `INSERT INTO correction_label (message_id, label, rule, labeled_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(message_id) DO UPDATE SET label = excluded.label, rule = excluded.rule,
         labeled_at = excluded.labeled_at`,
      [messageId, label, rule],
    );
    console.log(`labeled ${messageId} as ${label}`);
  } finally {
    closeDb(db);
  }
}

function runQuery(args: string[]): void {
  const name = args[0];
  if (!name || name === "list") {
    for (const q of QUERIES) {
      console.log(`  ${(q.usage ?? `dim q ${q.name}`).padEnd(28)} ${q.summary}`);
    }
    return;
  }
  const query = findQuery(name);
  if (!query) {
    console.error(`dim: no query named ${name}; try \`dim q list\``);
    process.exit(1);
  }
  const flagValues = new Set<string>();
  const sinceFlag = args.indexOf("--since");
  if (sinceFlag !== -1 && args[sinceFlag + 1]) flagValues.add(args[sinceFlag + 1] as string);
  const arg = args.find((a) => !a.startsWith("--") && a !== name && !flagValues.has(a));
  const since = windowFromArgs(args, { spansHistory: query.spansHistory });
  const db = openReadOnly(dbPath());
  try {
    const result = query.run(db, { arg, since });
    console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : renderTable(result));
  } finally {
    db.close();
  }
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
    case "label":
      runLabel(process.argv.slice(3));
      break;
    case "q":
      runQuery(process.argv.slice(3));
      break;
    case "install-agent":
      printAgentPlan(process.argv.includes("--write"));
      break;
    case "install-skill":
      printSkillPlan(process.argv.includes("--write"));
      break;
    default:
      console.log(USAGE);
      process.exit(1);
  }
} catch (error) {
  console.error(`dim: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
