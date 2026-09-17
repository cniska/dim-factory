#!/usr/bin/env bun
// dim — read Claude Code and Codex session records into a local SQLite database.
// No model call happens anywhere below this line.

import { AGENT_LABEL, installAgent, planAgent } from "./agent";
import { checkRange } from "./check-commits";
import { checkoutDirs, installCommitGate, ownerOf, planCommitGate, sharedHooksDir } from "./commit-gate";
import { closeDb, openDb } from "./db";
import { diagnose } from "./doctor";
import { installHooks, planHooks } from "./hooks";
import { withLock } from "./lock";
import { dbPath, resolveHomeDir } from "./paths";
import { findQuery, QUERIES } from "./queries";
import { openReadOnly } from "./read-db";
import { renderTable } from "./render";
import { installRules, planRules } from "./rules";
import { DEFAULT_WINDOW, windowFromArgs } from "./since";
import { installSkill, planSkill, SKILL_NAMES } from "./skill";
import { ensureSpoolDirs } from "./spool";
import { rebuild, type SyncReport, sync } from "./sync";
import { readWake, renderWake, wireFor } from "./wake";
import { installWt, planWt } from "./wt";

const USAGE = `usage: dim <command>

  init            create the database and its schema
  sync            read every new byte of both tools' session files
  rebuild         forget every cursor and read all files from the start
  stats           row counts and token totals per tool and model
  doctor          check that collection is actually working, and say what to fix
  install-hooks   show the session hooks to add to both tools' config
                  (--write applies them, after copying each config aside)
  install-agent   show the launchd agent that syncs every 15 minutes
                  (--write writes the plist; load it with launchctl)
  install-rules   flatten ~/.claude/CLAUDE.md into ~/.codex/AGENTS.md, which
                  reads no imports (--write applies it, keeping a backup)
  install-skill   show where this repo's skills would be linked for agents
                  (--write creates the link, moving anything there aside)
  install-commit-gate
                  show which checkouts would get the commit-subject hook
                  (--write installs it, skipping repos that gate their own)
  install-wt      show where wt would be linked onto PATH; --write links it,
                  keeping whatever is there as a backup
  wake            the one thing a cold start here cannot work out: what the last
                  session in this directory left as Next (for the SessionStart hook)
  check-commits <range>
                  judge every authored subject in a revision range by the same
                  rules the commit gate holds, and name each one that breaks
  sql <select>    run one read-only statement against the database (--json)
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
  if (report.repoFiles.repos > 0) {
    console.log(`files: ${report.repoFiles.files} tracked in ${report.repoFiles.repos} repos`);
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

function printRulesPlan(write: boolean): void {
  const plan = planRules();
  if (plan.state === "missing-source") {
    console.log(`rules: ${plan.source} does not exist; nothing to flatten`);
    return;
  }
  if (plan.state === "unchanged") {
    console.log(`rules: ${plan.path} already matches ${plan.source}`);
    return;
  }
  const lines = plan.contents.split("\n").length;
  console.log(`${plan.path} <- ${plan.source} (${lines} lines, imports expanded)`);
  if (plan.state === "stale") console.log("  the file there differs; it would be replaced");
  if (!write) {
    console.log("\nRe-run with --write to apply.");
    return;
  }
  installRules();
  if (plan.state === "stale") console.log(`previous version kept at ${plan.path}.dim-backup`);
  console.log(`wrote ${plan.path}`);
}

function printSkillPlan(write: boolean): void {
  const plans = planSkill();
  const pending = plans.filter((p) => p.state !== "linked");
  if (pending.length === 0) {
    console.log(`skills: ${SKILL_NAMES.length} already linked for every tool`);
    for (const plan of plans) console.log(`  ${plan.link}`);
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
 * The checkouts the corpus has seen commits from: where the rule is actually
 * broken is where it is worth gating, and a repo with a gate of its own keeps it.
 */
function printCommitGatePlan(write: boolean): void {
  const owners = process.argv.filter((a) => a.startsWith("--owner=")).map((a) => a.slice("--owner=".length));
  const db = openReadOnly(dbPath());
  let checkouts: { repo: string; owner: string }[];
  try {
    checkouts = db
      .query("SELECT DISTINCT repo, label FROM repo_commit ORDER BY repo")
      .all()
      .map((r) => {
        const row = r as { repo: string; label: string | null };
        return { repo: row.repo, owner: ownerOf(row.label) };
      });
  } finally {
    db.close();
  }

  if (owners.length === 0) {
    console.log(
      "name the owners whose commits to gate, so a clone of someone else's project keeps its own rules:",
    );
    for (const owner of [...new Set(checkouts.map((c) => c.owner))].filter(Boolean).sort()) {
      const n = checkouts.filter((c) => c.owner === owner).length;
      console.log(`  --owner=${owner}  (${n} checkouts)`);
    }
    return;
  }

  const stranded = checkoutDirs(checkouts);
  const plan = planCommitGate(owners, stranded);
  console.log(`one hook for every repo: ${plan.hookPath} (${plan.state})`);
  console.log(`  enforced for: ${owners.join(", ")}`);
  console.log(`  git core.hooksPath (global): ${plan.globalHooksPath ?? "unset"}`);
  for (const copy of plan.strandedCopies) console.log(`  replaces a per-repo copy at ${copy}`);
  console.log("  a repo setting its own core.hooksPath keeps the hooks it already has");

  const taken = plan.globalHooksPath !== null && plan.globalHooksPath !== sharedHooksDir();
  if (taken) {
    console.log(`\nrefused: ${plan.globalHooksPath} already holds the one hooks directory git reads`);
    console.log("  point that directory at this hook, or `git config --global --unset core.hooksPath`");
    return;
  }
  if (!write) {
    console.log("\nRe-run with --write to apply.");
    return;
  }
  const done = installCommitGate(owners, stranded);
  console.log(`\nwrote ${done.hookPath}`);
  console.log(`set global core.hooksPath to ${done.globalHooksPath}`);
  for (const copy of done.strandedCopies) console.log(`removed ${copy}`);
}

function printWtPlan(write: boolean): void {
  const plan = planWt();
  console.log(`wt: ${plan.link} -> ${plan.source} (${plan.state})`);
  if (plan.occupant) console.log(`  something else is there: ${plan.occupant}`);
  console.log("  a link rather than a copy, so the script on PATH cannot drift from the tested one");

  if (plan.state === "linked") return;
  if (!write) {
    console.log("\nRe-run with --write to link it.");
    return;
  }
  const done = installWt();
  if (plan.occupant) console.log(`kept the previous ${done.link} at ${done.link}.dim-backup`);
  console.log(`linked ${done.link}`);
}

/**
 * Runs before every session once wired to the SessionStart hook, so it may never
 * fail and never print a diagnostic: anything unexpected is silence, and the
 * session starts as it would have without it.
 */
function runWake(args: string[]): void {
  const tool = args.includes("--tool=codex") ? "codex" : "claude";
  try {
    const db = openReadOnly(dbPath());
    try {
      const wire = wireFor(tool, renderWake(readWake(db, process.cwd())));
      if (wire) console.log(wire);
    } finally {
      db.close();
    }
  } catch {
    // no database, no read, nothing to say
  }
}

/**
 * The backstop for the commit gate: a hook is skippable with `--no-verify` and
 * absent on a fresh clone, so CI reads what actually landed.
 */
function runCheckCommits(range: string | undefined): void {
  if (!range) throw new Error("check-commits needs a revision range, e.g. main..HEAD");
  const offenses = checkRange(range);
  for (const o of offenses) {
    console.error(`${o.sha.slice(0, 8)} ${o.violation}: ${o.subject}`);
  }
  if (offenses.length > 0) process.exit(1);
  console.log(`every authored subject in ${range} holds`);
}

/**
 * The escape hatch the named questions are grown from: a question worth asking
 * twice becomes one of them, and until it is, asking it should not mean leaving
 * the tool. The connection is read-only, so a statement that writes is refused
 * by SQLite rather than by a rule here that could be wrong about what writes.
 */
function runSql(statement: string | undefined, json: boolean): void {
  if (!statement) throw new Error('sql needs one statement, as in: dim sql "SELECT count(*) FROM session"');
  const db = openReadOnly(dbPath());
  try {
    const rows = db.prepare(statement).all() as Record<string, unknown>[];
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];
    console.log(
      renderTable({
        denominator: `${rows.length} rows`,
        columns,
        rows: rows.map((r) => columns.map((c) => (r[c] ?? null) as string | number | null)),
        note: rows.length === 0 ? "the statement ran and matched nothing" : undefined,
      }),
    );
  } finally {
    db.close();
  }
}

/**
 * Read-only, so a broken collection path can be diagnosed without writing to a
 * database that may be the thing at fault.
 */
function runDoctor(): void {
  const db = openReadOnly(dbPath());
  try {
    const checks = diagnose(db);
    const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
    for (const c of checks) {
      console.log(`${mark[c.state]}  ${c.name.padEnd(13)} ${c.detail}`);
      if (c.fix) console.log(`${" ".repeat(21)}fix: ${c.fix}`);
    }
    const failed = checks.filter((c) => c.state === "fail").length;
    console.log(
      failed === 0
        ? `\n${checks.length} checks, nothing failing`
        : `\n${failed} of ${checks.length} checks failing`,
    );
    if (failed > 0) process.exit(1);
  } finally {
    db.close();
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
    const result = query.run(db, { arg, since, home: resolveHomeDir() });
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
    case "sql":
      runSql(process.argv[3], process.argv.includes("--json"));
      break;
    case "q":
      runQuery(process.argv.slice(3));
      break;
    case "install-agent":
      printAgentPlan(process.argv.includes("--write"));
      break;
    case "doctor":
      runDoctor();
      break;
    case "install-rules":
      printRulesPlan(process.argv.includes("--write"));
      break;
    case "install-skill":
      printSkillPlan(process.argv.includes("--write"));
      break;
    case "install-commit-gate":
      printCommitGatePlan(process.argv.includes("--write"));
      break;
    case "install-wt":
      printWtPlan(process.argv.includes("--write"));
      break;
    case "wake":
      runWake(process.argv.slice(3));
      break;
    case "check-commits":
      runCheckCommits(process.argv[3]);
      break;
    default:
      console.log(USAGE);
      process.exit(1);
  }
} catch (error) {
  console.error(`dim: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
