#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { AGENT_LABEL, installAgent, planAgent } from "./agent";
import { runBench } from "./bench";
import { corpusPath, parseCorpus } from "./bench-corpus";
import { checkRange } from "./check-commits";
import { checkoutRoot } from "./checkout";
import { checkoutDirs, installCommitGate, planCommitGate, sharedHooksDir } from "./commit-gate";
import { closeDb, openDb } from "./db";
import { diagnose } from "./doctor";
import { downloadEmbedder, EMBED_DIMS, EMBED_MODEL, embedQuestion } from "./embed";
import { buildIndex } from "./embed-index";
import { writeFactoryError, writeFactorySuccess } from "./factory-output";
import { createSchedule, setSchedulePaused } from "./factory-schedule";
import { clearStop, FactoryStopError, pullStop } from "./factory-stop";
import { serveWall } from "./factory-wall";
import { WorkerUnknown } from "./factory-worker";
import { type Finding, FindingError, findingFrom, recordFinding } from "./finding";
import { readFlags, requiredFlag } from "./flags";
import { committerName } from "./git-identity";
import { checkoutSlug, labelFor } from "./git-remote";
import { parseHarness } from "./harness-name";
import { installHooks, planHooks } from "./hooks";
import { withLock } from "./lock";
import { OPERATOR_USAGE, OperatorCommandError, runOperatorCommand } from "./operator-command";
import { ORDER_USAGE, OrderCommandError, runOrderCommandLive } from "./order-command";
import { dbPath, resolveHomeDir } from "./paths";
import { findQuery, QUERIES, type QueryResult } from "./queries";
import { openReadOnly } from "./read-db";
import { isHostQualified } from "./remote-slug";
import { DEFAULT_MAX_ROWS, renderTable, rowsFromArgs } from "./render";
import { routeReport } from "./routing";
import { installRules, planRules } from "./rules";
import { DEFAULT_WINDOW, windowFromArgs } from "./since";
import { installSkill, planSkill, retiredLinks, SKILL_NAMES } from "./skill";
import { ensureSpoolDirs } from "./spool";
import { type RebuildReport, rebuild, type SyncReport, sync } from "./sync";
import { trace } from "./trace";
import { runTraceCommand } from "./trace-command";
import { readWake, renderWake, type Wake, wireFor } from "./wake";
import { resolveWalk, spoolWalk } from "./walk";
import { DEFAULT_WALL_PORT, WALL_HOT_ENV, WALL_PORT_ENV, WallPortError, wallPort } from "./wall-port";
import { warn } from "./warn";
import { checkCommand } from "./workspace-commands";
import { runWt, WtError } from "./wt-command";

const USAGE = `usage: dim <command>

  init            create the database and its schema
  sync            read every new byte of both tools' session files
  rebuild         forget every cursor and read all files from the start
  embed           index the text a person distilled — handoff nexts, their own
                  commit subjects, labeled corrections — for \`q search\`
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
  wt              parallel-task worktrees, one per agent; dim wt for usage
  wake            the one thing a cold start here cannot work out: what the last
                  session in this directory left as Next (for the SessionStart hook)
  check-command   print the check command this repo declares, and nothing if it
                  declares none or this is not a checkout (the pre-commit hook
                  reads this, and takes silence as no gate)
  comments check  print path:line for each comment on a staged added line of a
                  file in a language dim reads and exit 3, where the config at
                  HEAD bans comments; nothing and exit 0 otherwise
  comments purge [<path>...]
                  report each tracked file with comments and how many, tool
                  contracts aside (--write removes them, bans comments in the
                  project config and runs the repo's formatter)
  config [list]   print the user and project config, and what they resolve to
  config set|unset <key> [<value>] [--project]
                  change a setting in the user config, or the project's
  route <harness> [<role>]
                  print the capability tier a factory role runs at and what this
                  harness's map calls it, or every role with no role argument
  check-commits <range>
                  judge every authored subject in a revision range by the same
                  rules the commit gate holds, and name each one that breaks
  bench           score retrieval against the questions in retrieval.jsonl,
                  beside the database (--k <n> for the cutoff, default 10)
  sql <select>    run one read-only statement against the database (--json)
  q <name> [arg]  ask the database a named question (q list names them; --json)
                  covers the last ${DEFAULT_WINDOW}; --since <n>d|YYYY-MM-DD or --all to widen
                  prints ${DEFAULT_MAX_ROWS} rows; --rows <n> for more
  trace <order-id> stream an order's diagnostic events as JSONL until it reaches a terminal state
  schedule define <id> <queue> --every <seconds> [--paused]
                  persist a harness-neutral recurring schedule
  schedule pause|resume <id>
                  pause or resume a persisted schedule
  wall            serve the local read-only factory wall on loopback, at one
                  address every run (${DEFAULT_WALL_PORT}, or ${WALL_PORT_ENV}); --dev reloads
                  both the page and the server as you edit
  label <id> <correction|clarification|not_correction> [--rule "..."]
                  record your judgement on one candidate correction
  finding --slice <name> --dimension <name> --answer <fixed|refused>
          --summary "..." [--file <path>] [--why "..."]
                  record what a checking agent raised on a slice and how it was
                  answered; a refusal states why, which is what ends a finding
  order claim|start|move|stop <order-id> ...
                  record a factory order as it is taken, started, moved between
                  stations and stopped, so the wall shows the work while it is
                  happening (dim order for the flags each subcommand takes)
  order ship <order-id>
                  land a working order's commits on the repo's trunk without
                  rewriting them, under the factory lock
  order commit|file|check|finding|document <order-id> ...
                  record what a running order produced — a commit and its subject,
                  a file it changed, a check and its exit status, a finding and
                  how it was answered, a doc it updated
  factory stop --reason "..." [--order <id>] [--by <who>]
                  stop the whole floor taking new work, because the defect is in
                  the machinery; orders already running are left to finish
  factory clear [--by <who>]
                  clear the live stop, so claims are taken again
  order add <order-id> --title "..." [--description "..."] [--priority <p>]
            [--hold "..."] [--project <owner/repo>]
                  queue one order on a project, which defaults to its owner/repo
  order ready [--limit <n>] [--project <owner/repo>]
                  print the orders nobody holds, most urgent first and oldest
                  before newest within a priority, with the held ones beside them
  operator
                  resolve this project's active operator identity
`;

function printReport(report: SyncReport | RebuildReport): void {
  if ("orphans" in report) {
    for (const { table, rows } of report.orphans) {
      warn(`dim: dropped ${rows} ${table} rows whose order is gone`);
    }
    if (report.retired.length > 0) {
      console.log(`retired: dropped ${report.retired.join(", ")}`);
    }
  }
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
  if (report.walk.sessions > 0) {
    console.log(
      `walk: ${report.walk.surfaces} rules surfaces recorded for ${report.walk.sessions} session starts`,
    );
  }
  if (report.chain.pasted > 0) {
    console.log(
      `chain: ${report.chain.linked} of ${report.chain.pasted} pasted handoffs joined to the session that wrote them`,
    );
  }
  if (report.history.orphans > 0) {
    console.log(
      `history: ${report.history.orphans} prompts from sessions with no transcript, of ${report.history.read} read`,
    );
  }
  if (report.orphanSubagents.length > 0) {
    console.log(`${report.orphanSubagents.length} subagents whose parent session is gone, recorded unlinked`);
  }
  for (const drop of report.dropped) {
    warn(
      `dim: ${drop.path}: ${drop.lines.length} lines were not JSON and are lost ` +
        `(line ${drop.lines.slice(0, 5).join(", ")}${drop.lines.length > 5 ? ", …" : ""})`,
    );
  }
  for (const failure of report.failures) {
    warn(`dim: ${failure.path}: ${failure.error}`);
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

function withDb(fn: (db: ReturnType<typeof openDb>) => SyncReport | RebuildReport, forRebuild = false): void {
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
  const pending = plans.filter((p) => p.state !== "installed");
  if (pending.length === 0) {
    console.log(`hooks: all ${plans.length} session hooks are already installed`);
    return;
  }
  for (const plan of pending) {
    const where = plan.state === "stale" ? (plan.at as (string | number)[]).join(".") : `hooks.${plan.event}`;
    console.log(`${plan.configPath}\n  ${where} ${plan.state === "stale" ? "=" : "+="} ${plan.command}`);
  }
  if (!write) {
    console.log(`\n${pending.length} to write. Re-run with --write to apply.`);
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
  const retired = retiredLinks();
  if (pending.length === 0 && retired.length === 0) {
    console.log(`skills: ${SKILL_NAMES.length} already linked for every tool`);
    for (const plan of plans) console.log(`  ${plan.link}`);
    return;
  }
  for (const plan of pending) {
    console.log(`${plan.link} -> ${plan.target}`);
    if (plan.state === "occupied") console.log("  something else is at that name; it would be moved aside");
  }
  for (const link of retired) console.log(`${link}: its skill no longer ships; it would be removed`);
  if (!write) {
    console.log(`\n${pending.length} to link, ${retired.length} to remove. Re-run with --write to apply.`);
    return;
  }
  installSkill();
  for (const plan of pending) {
    if (plan.state === "occupied") console.log(`previous version kept at ${plan.link}.dim-backup`);
    console.log(`linked ${plan.link}`);
  }
  for (const link of retired) console.log(`removed ${link}`);
}

function printCommitGatePlan(write: boolean): void {
  const owners = process.argv.filter((a) => a.startsWith("--owner=")).map((a) => a.slice("--owner=".length));
  const db = openReadOnly(dbPath());
  let checkouts: { repo: string; owner: string }[];
  try {
    checkouts = db
      .query("SELECT DISTINCT repo FROM repo_commit ORDER BY repo")
      .all()
      .map((r) => {
        const row = r as { repo: string };
        return { repo: row.repo, owner: checkoutSlug(row.repo) ?? "" };
      });
  } finally {
    db.close();
  }

  const bare = owners.filter((o) => !isHostQualified(o));
  if (bare.length > 0) {
    console.log(`refused: ${bare.join(", ")} names an account but no host, so the gate would arm nowhere.`);
    console.log("  an owner is the whole of a remote URL before the repository, as in github.com/<account>.");
    return;
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
  console.log(`one set of hooks for every repo, in ${sharedHooksDir()}:`);
  for (const hook of plan.hooks) console.log(`  ${hook.name} (${hook.state})`);
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
  console.log(`\nwrote ${done.hooks.map((h) => h.name).join(", ")} to ${sharedHooksDir()}`);
  console.log(`set global core.hooksPath to ${done.globalHooksPath}`);
  for (const copy of done.strandedCopies) console.log(`removed ${copy}`);
}

async function hookPayload(): Promise<{ session_id?: string; cwd?: string }> {
  if (Bun.stdin.stream().locked || process.stdin.isTTY) return {};
  try {
    const raw = await Bun.stdin.text();
    return raw.trim() === "" ? {} : (JSON.parse(raw) as { session_id?: string; cwd?: string });
  } catch {
    return {};
  }
}

async function runWake(args: string[]): Promise<void> {
  const tool = args.includes("--tool=codex") ? "codex" : "claude";
  const payload = await hookPayload();
  const cwd = payload.cwd ?? process.cwd();

  if (payload.session_id) {
    try {
      spoolWalk({
        session_id: payload.session_id,
        tool,
        seen_at: new Date().toISOString(),
        surfaces: resolveWalk(tool, cwd),
      });
    } catch {}
  }

  let wake: Wake | null = null;
  try {
    const db = openReadOnly(dbPath());
    try {
      wake = readWake(db, cwd);
    } finally {
      db.close();
    }
  } catch {}

  try {
    const wire = wireFor(tool, renderWake(wake, cwd));
    if (wire) console.log(wire);
  } catch {}
}

const DEFAULT_CUTOFF = 10;

function benchCutoff(args: string[]): number {
  const at = args.indexOf("--k");
  if (at === -1) return DEFAULT_CUTOFF;
  const given = args[at + 1];
  const k = Number(given);
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(
      given === undefined
        ? "--k takes a whole number above zero"
        : `--k takes a whole number above zero, not ${given}`,
    );
  }
  return k;
}

async function runBenchCommand(args: string[]): Promise<void> {
  const path = corpusPath();
  if (!existsSync(path)) {
    console.log(`no corpus at ${path}; a question is a line of JSON — see docs/design.md`);
    return;
  }
  const questions = parseCorpus(await readFile(path, "utf8"));
  const k = benchCutoff(args);
  const db = openReadOnly(dbPath());
  try {
    const report = await runBench(db, questions, k, { home: resolveHomeDir() }, embedQuestion);
    const scored = report.scores.length;
    console.log(
      renderTable({
        denominator:
          scored === 0
            ? `nothing of the ${questions.length} questions in the corpus could be scored`
            : `${scored} of ${questions.length} questions scored at k=${k}: ` +
              `recall ${report.recall.toFixed(3)}, nDCG ${report.ndcg.toFixed(3)}.` +
              (report.capped > 0
                ? ` ${report.capped} of them returned fewer than ${k} rows, so their score is over what came back.`
                : ""),
        columns: ["question", "query", "returned", "graded", "recall", "ndcg"],
        rows: report.scores.map((s) => [
          s.id,
          s.query,
          s.returned,
          s.graded,
          s.recall.toFixed(3),
          s.ndcg.toFixed(3),
        ]),
        note: scored === 0 ? "every question is listed below with the reason" : undefined,
      }),
    );
    for (const { id, why } of report.unscorable) console.log(`unscored  ${id}: ${why}`);
  } finally {
    db.close();
  }
}

function runCheckCommits(range: string | undefined): void {
  if (!range) throw new Error("check-commits needs a revision range, e.g. main..HEAD");
  const offenses = checkRange(range);
  for (const o of offenses) {
    warn(`${o.sha.slice(0, 8)} ${o.violation}: ${o.subject}`);
  }
  if (offenses.length > 0) process.exit(1);
  console.log(`every authored subject in ${range} holds`);
}

async function runEmbed(): Promise<void> {
  const embed = await downloadEmbedder();
  await withLock(async () => {
    const db = openDb(dbPath());
    try {
      console.log(`${EMBED_MODEL}, ${EMBED_DIMS} dims per passage`);
      const report = await buildIndex(db, embed, committerName(), (done, total) => {
        if (done % 1000 === 0 || done === total) console.log(`  ${done} of ${total}`);
      });
      const { found } = report;
      console.log(
        `distilled: ${found.next} handoff nexts, ${found.subject} commit subjects, ` +
          `${found.correction} corrections`,
      );
      console.log(
        `${report.embedded} embedded, ${report.unchanged} already current, ` +
          `${report.removed} dropped because the source is gone`,
      );
      if (found.correction === 0) {
        console.log("no prompt is labeled a correction yet; `dim q candidates` narrows, `dim label` records");
      }
    } finally {
      closeDb(db);
    }
  });
}

function statementIn(args: string[]): string | undefined {
  const rows = args.indexOf("--rows");
  const value = rows === -1 ? -1 : rows + 1;
  return args.find((a, i) => !a.startsWith("--") && i !== value);
}

function runSql(statement: string | undefined, json: boolean, maxRows: number): void {
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
      renderTable(
        {
          denominator: `${rows.length} rows`,
          columns,
          rows: rows.map((r) => columns.map((c) => (r[c] ?? null) as string | number | null)),
          note: rows.length === 0 ? "the statement ran and matched nothing" : undefined,
        },
        maxRows,
      ),
    );
  } finally {
    db.close();
  }
}

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

function runLabel(args: string[]): void {
  const [messageId, label] = args;
  const ruleAt = args.indexOf("--rule");
  const rule = ruleAt === -1 ? null : (args[ruleAt + 1] ?? null);
  if (!messageId || !label) {
    warn('usage: dim label <message-id> <correction|clarification|not_correction> [--rule "..."]');
    process.exit(1);
  }
  const db = openDb(dbPath());
  try {
    const found = db.prepare("SELECT id FROM message WHERE id = ?").get(messageId);
    if (!found) {
      warn(`dim: no message ${messageId}`);
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

function runFinding(args: string[]): void {
  let finding: Finding;
  try {
    finding = findingFrom(args, process.cwd());
  } catch (error) {
    if (!(error instanceof FindingError)) throw error;
    warn(error.message);
    process.exit(1);
  }
  const db = openDb(dbPath());
  try {
    recordFinding(db, finding);
    console.log(`recorded a ${finding.answer} finding on ${finding.slice}`);
  } finally {
    closeDb(db);
  }
}

function runSchedule(args: string[]): void {
  const action = args[0];
  const id = args[1];
  if (action === "define") {
    const queue = args[2];
    const everyAt = args.indexOf("--every");
    const intervalSeconds = everyAt === -1 ? Number.NaN : Number(args[everyAt + 1]);
    if (!id || !queue || !Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error("usage: dim schedule define <id> <queue> --every <positive-seconds> [--paused]");
    }
    const db = openDb(dbPath());
    try {
      createSchedule(db, { id, queueId: queue, intervalSeconds, paused: args.includes("--paused") });
      writeFactorySuccess("schedule", { action: "defined", schedule_id: id, queue_id: queue });
    } finally {
      closeDb(db);
    }
    return;
  }
  if ((action === "pause" || action === "resume") && id) {
    const db = openDb(dbPath());
    try {
      setSchedulePaused(db, id, action === "pause");
      writeFactorySuccess("schedule", { action, schedule_id: id });
    } finally {
      closeDb(db);
    }
    return;
  }
  throw new Error("usage: dim schedule define|pause|resume ...");
}

const FACTORY_USAGE = `usage: dim factory stop --reason "..." [--order <id>] [--by <who>]
       dim factory clear [--by <who>]`;

const factoryFail = (message: string): Error => new FactoryStopError("usage", message);

function runFactory(args: string[]): void {
  const [action, ...rest] = args;
  if (action !== "stop" && action !== "clear") {
    throw new FactoryStopError("usage", `${action ?? "factory"} is not a factory subcommand`);
  }
  const given = readFlags(rest, action === "stop" ? ["--reason", "--order", "--by"] : ["--by"], factoryFail);
  const db = openDb(dbPath());
  try {
    if (action === "stop") {
      const stop = pullStop(db, {
        reason: requiredFlag(given, "--reason", factoryFail),
        by: given.get("--by"),
        orderId: given.get("--order"),
      });
      writeFactorySuccess("factory", {
        action: "stopped",
        by: stop.pulledBy,
        reason: stop.reason,
        order_id: stop.orderId,
      });
      return;
    }
    const cleared = clearStop(db, given.get("--by"));
    writeFactorySuccess("factory", { action: "cleared", reason: cleared.reason });
  } finally {
    closeDb(db);
  }
}

async function runQuery(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name === "list") {
    for (const q of QUERIES) {
      console.log(`  ${(q.usage ?? `dim q ${q.name}`).padEnd(28)} ${q.summary}`);
    }
    return;
  }
  const query = findQuery(name);
  if (!query) {
    warn(`dim: no query named ${name}; try \`dim q list\``);
    process.exit(1);
  }
  const flagValues = new Set<string>();
  for (const flag of ["--since", "--rows"]) {
    const at = args.indexOf(flag);
    if (at !== -1 && args[at + 1]) flagValues.add(args[at + 1] as string);
  }
  const arg = args.find((a) => !a.startsWith("--") && a !== name && !flagValues.has(a));
  const since = windowFromArgs(args, { spansHistory: query.spansHistory });
  const question = query.embedsArg && arg ? await embedQuestion(arg) : undefined;
  const db = openReadOnly(dbPath());
  const started = Date.now();
  try {
    let result: QueryResult | undefined;
    try {
      result = query.run(db, { arg, since, home: resolveHomeDir(), question });
      console.log(
        args.includes("--json") ? JSON.stringify(result, null, 2) : renderTable(result, rowsFromArgs(args)),
      );
    } finally {
      trace({
        event: "query.completed",
        command: "q",
        name: query.name,
        path: result?.path,
        rowCount: result?.rows.length,
        durationMs: Date.now() - started,
      });
    }
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
    case "finding":
      runFinding(process.argv.slice(3));
      break;
    case "schedule":
      runSchedule(process.argv.slice(3));
      break;
    case "factory":
      runFactory(process.argv.slice(3));
      break;
    case "wall":
      {
        const dev = process.argv.includes("--dev");
        if (dev && process.env[WALL_HOT_ENV] !== "1") {
          const child = Bun.spawn(["bun", "--hot", import.meta.path, ...process.argv.slice(2)], {
            env: { ...process.env, [WALL_HOT_ENV]: "1" },
            stdio: ["inherit", "inherit", "inherit"],
          });
          process.exit(await child.exited);
        }
        const port = wallPort();
        const server = await serveWall({ port, hmr: dev }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
            throw new WallPortError(
              "in-use",
              `something already listens on ${port}. It may be an older wall: open ` +
                `http://127.0.0.1:${port}, or stop it and run this again, or set ${WALL_PORT_ENV}`,
            );
          }
          throw error;
        });
        console.log(`factory wall listening at http://${server.hostname}:${server.port}`);
      }
      break;
    case "sql":
      runSql(
        statementIn(process.argv.slice(3)),
        process.argv.includes("--json"),
        rowsFromArgs(process.argv.slice(3)),
      );
      break;
    case "q":
      await runQuery(process.argv.slice(3));
      break;
    case "trace":
      await runTraceCommand(process.argv[3]);
      break;
    case "order":
      {
        const root = checkoutRoot(process.cwd());
        const db = openDb(dbPath());
        try {
          writeFactorySuccess(
            "order",
            await runOrderCommandLive(db, process.argv.slice(3), root ? labelFor(root) : null),
          );
        } finally {
          closeDb(db);
        }
      }
      break;
    case "operator":
      {
        const db = openDb(dbPath());
        try {
          console.log(runOperatorCommand(db, process.argv.slice(3), process.env, process.cwd()));
        } finally {
          closeDb(db);
        }
      }
      break;
    case "embed":
      await runEmbed();
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
    case "wt":
      runWt(process.argv.slice(3));
      break;
    case "wake":
      await runWake(process.argv.slice(3));
      break;
    case "check-command":
      {
        const root = checkoutRoot(process.cwd());
        const declared = root === null ? null : checkCommand(root);
        if (declared) console.log(declared.command);
      }
      break;
    case "comments":
      (await import("./comments-command")).runComments(process.argv.slice(3));
      break;
    case "config":
      (await import("./config-command")).runConfig(process.argv.slice(3));
      break;
    case "route":
      writeFactorySuccess("route", routeReport(parseHarness(process.argv[3]), process.argv[4]));
      break;
    case "check-commits":
      runCheckCommits(process.argv[3]);
      break;
    case "bench":
      await runBenchCommand(process.argv.slice(3));
      break;
    default:
      warn(USAGE);
      process.exit(1);
  }
} catch (error) {
  const factoryCommand = process.argv[2];
  if (
    factoryCommand === "order" ||
    factoryCommand === "schedule" ||
    factoryCommand === "factory" ||
    factoryCommand === "trace" ||
    factoryCommand === "route"
  ) {
    writeFactoryError(factoryCommand, error);
    process.exit(1);
  }
  if (error instanceof WtError) {
    warn(`wt: ${error.message}`);
    process.exit(1);
  }
  if (error instanceof FactoryStopError) {
    warn(`dim: ${error.message}`);
    if (error.code === "usage") warn(FACTORY_USAGE);
    process.exit(1);
  }
  if (error instanceof OrderCommandError) {
    warn(`dim: ${error.message}`);
    warn(ORDER_USAGE);
    process.exit(1);
  }
  if (error instanceof OperatorCommandError) {
    warn(`dim: ${error.message}`);
    if (error.message !== OPERATOR_USAGE) warn(OPERATOR_USAGE);
    process.exit(1);
  }
  if (error instanceof WorkerUnknown) {
    warn(`dim: ${error.message}`);
    process.exit(1);
  }
  warn(`dim: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
