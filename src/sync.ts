import type { Database, SQLQueryBindings } from "bun:sqlite";
import { listClaudeSubagents, listClaudeTranscripts } from "./claude-source";
import { listCodexRollouts, readCodexTitles } from "./codex-source";
import { type GitReport, ingestCommits } from "./git-ingest";
import { type GuidanceReport, ingestGuidance } from "./guidance";
import { backfillHandoffs, type HandoffLinkReport, linkHandoffs } from "./handoff";
import { type HistoryReport, ingestHistory } from "./history";
import { createIngester, type FileSpec } from "./ingest";
import type { Env } from "./paths";
import { type RepoCheckReport, recordRepoChecks } from "./repo-check";
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
  dropped: { path: string; lines: number[] }[];
  hooks: DrainReport;
  history: HistoryReport;
  git: GitReport;
  repoFiles: RepoFileReport;
  repoChecks: RepoCheckReport;
  guidance: GuidanceReport;
  chain: HandoffLinkReport;
  walk: WalkReport;
};

export type RebuildReport = SyncReport & { orphans: OrphanReport[]; retired: string[] };

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
    repoChecks: { repos: 0 },
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

  applyHookEvents(db);
  report.history = ingestHistory(db, env);
  report.git = ingestCommits(db);
  report.repoFiles = indexRepoFiles(db);
  report.repoChecks = recordRepoChecks(db);
  report.guidance = ingestGuidance(db, env);
  backfillHandoffs(db);
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

type HookEvent = {
  tool: string;
  session_id: string;
  event: string;
  ts: string;
  source: string | null;
  reason: string | null;
  model: string | null;
  cwd: string | null;
  payload: string;
};

const PARENT_ORDER_TABLE = "factory_order";

const FACTORY_ORDER_TABLES = [
  "factory_worker",
  "factory_worker_assignment",
  "factory_worker_session",
  PARENT_ORDER_TABLE,
  "factory_order_worker",
  "factory_order_build",
  "factory_order_attempt",
  "factory_schedule_invocation",
  "factory_order_verdict",
  "factory_order_delivery",
  "factory_order_commit",
  "factory_order_file",
  "factory_order_check",
  "factory_order_rewrite",
  "factory_order_review",
  "factory_order_review_artifact",
  "factory_order_finding",
  "factory_order_finding_answer",
  "factory_order_event",
  "factory_order_finding_ruling",
  "factory_order_document",
  "factory_order_environment",
  "factory_order_plan",
  "factory_order_slice",
  "factory_order_slice_completion",
  "factory_stop",
];

function assertCascadesCarried(db: Database, tables: string[]): void {
  const carried = new Set(tables);
  const defined = new Set(
    [...SCHEMA_SQL.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/g)].map(
      (match) => match[1] as string,
    ),
  );
  const lost = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
    .filter((name) => defined.has(name) && !carried.has(name) && !name.startsWith("sqlite_"))
    .filter((name) =>
      db
        .query<{ table: string; on_delete: string }, []>(`PRAGMA foreign_key_list(${name})`)
        .all()
        .some((key) => carried.has(key.table) && key.on_delete === "CASCADE"),
    );
  if (lost.length > 0) {
    throw new Error(
      `${lost.join(", ")} cascades from a table the rebuild drops and nothing carries it back: ` +
        "add it to FACTORY_ORDER_TABLES in src/sync.ts, below the table it hangs off.",
    );
  }
}

export type OrphanReport = { table: string; rows: number };

function dropOrphans(
  db: Database,
  saved: { table: string; rows: Record<string, SQLQueryBindings>[] }[],
): OrphanReport[] {
  const parent = saved.find((entry) => entry.table === PARENT_ORDER_TABLE);
  if (!parent) return [];
  const ids = new Set(parent.rows.map((row) => row.id as string));
  const orphans: OrphanReport[] = [];
  for (const entry of saved) {
    const key = db
      .query<{ from: string; table: string }, []>(`PRAGMA foreign_key_list(${entry.table})`)
      .all()
      .find((column) => column.table === PARENT_ORDER_TABLE);
    if (!key) continue;
    const kept = entry.rows.filter((row) => ids.has(row[key.from] as string));
    if (kept.length === entry.rows.length) continue;
    orphans.push({ table: entry.table, rows: entry.rows.length - kept.length });
    entry.rows = kept;
  }
  return orphans;
}

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

function carryThroughRebuild(
  db: Database,
  tables: string[],
): { restore: () => void; orphans: OrphanReport[] } {
  assertCascadesCarried(db, tables);
  const saved = tables.map((table) => ({
    table,
    rows: db.query(`SELECT * FROM ${table}`).all() as Record<string, SQLQueryBindings>[],
  }));
  const orphans = dropOrphans(db, saved);
  for (const table of [...tables].reverse()) db.run(`DROP TABLE IF EXISTS ${table}`);
  const restore = () => {
    for (const { table, rows } of saved) {
      const info = db
        .query<{ name: string; notnull: number; dflt_value: unknown }, []>(`PRAGMA table_info(${table})`)
        .all();
      const columns = new Set(info.map((column) => column.name));
      const demanded = info
        .filter((column) => column.notnull === 1 && column.dflt_value === null)
        .map((column) => column.name);
      for (const row of rows) {
        const missing = demanded.filter((name) => !(name in row));
        if (missing.length > 0) {
          throw new Error(
            `${table} holds rows written before ${missing.map((name) => `${table}.${name}`).join(", ")}, ` +
              "which the schema now requires and no source can supply. Fill or delete those rows with " +
              "sqlite3 against the database, then run `dim rebuild` again.",
          );
        }
        const names = Object.keys(row).filter((name) => columns.has(name));
        db.run(
          `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
          names.map((name) => row[name] as SQLQueryBindings),
        );
      }
    }
  };
  return { restore, orphans };
}

export function rebuild(db: Database, env: Env = process.env): RebuildReport {
  let orphans: OrphanReport[] = [];
  let retired: string[] = [];
  db.transaction(() => {
    const carried = carryThroughRebuild(db, FACTORY_ORDER_TABLES);
    orphans = carried.orphans;
    const restoreFactoryOrders = carried.restore;
    const labels = db
      .query<CorrectionLabel, []>(
        "SELECT message_id, label, skill_name, rule, labeled_at FROM correction_label",
      )
      .all();
    db.run("DROP TABLE IF EXISTS correction_label");
    const hookEvents = db
      .query<HookEvent, []>(
        "SELECT tool, session_id, event, ts, source, reason, model, cwd, payload FROM hook_event",
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
    db.run("DROP TABLE IF EXISTS repo_check");
    db.run("DROP TABLE IF EXISTS repo_commit");
    db.run("DROP TABLE IF EXISTS handoff_link");
    db.run("DROP TABLE IF EXISTS factory_handoff");
    db.run(SCHEMA_SQL);
    retired = dropRetiredTables(db);
    restoreFactoryOrders();
    const restore = db.prepare<void, [string, string, string | null, string | null, string]>(
      `INSERT INTO correction_label (message_id, label, skill_name, rule, labeled_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of labels) {
      restore.run(row.message_id, row.label, row.skill_name, row.rule, row.labeled_at);
    }
    const restoreHook = db.prepare<
      void,
      [string, string, string, string, string | null, string | null, string | null, string | null, string]
    >(
      `INSERT INTO hook_event (tool, session_id, event, ts, source, reason, model, cwd, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of hookEvents) {
      restoreHook.run(
        row.tool,
        row.session_id,
        row.event,
        row.ts,
        row.source,
        row.reason,
        row.model,
        row.cwd,
        row.payload,
      );
    }
  })();
  const report = sync(db, env);
  db.run("UPDATE schema_version SET version = ?", [SCHEMA_VERSION]);
  return { ...report, orphans, retired };
}
