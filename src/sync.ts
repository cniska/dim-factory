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
  /** Files with complete lines that were not JSON, and which line each was on. */
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
  report.repoChecks = recordRepoChecks(db);
  report.guidance = ingestGuidance(db, env);
  // Derived from the messages just written, so it follows every transcript pass.
  backfillHandoffs(db);
  report.chain = linkHandoffs(db);
  // After the hook spool is drained, since the rows it attributes are the ones just written.
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

/**
 * Parent first, which the restore needs: a child written before the order it
 * references fails the foreign key. The drop runs in reverse for a different
 * reason — every child cascades, so dropping the order first would empty them
 * instead of refusing, and a save ever moved after the drop would lose them
 * with nothing to show for it.
 */
const FACTORY_ORDER_TABLES = [
  // Ahead of the events that name a worker, for the same reason the order is ahead
  // of its own children.
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
  // After the check it names.
  "factory_order_rewrite",
  // Ahead of the findings that name it, for the same reason the order is ahead of its children.
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
  // No parent and no children, so its place in the list does not matter.
  "factory_stop",
];

/**
 * Whether a source can re-read a table is a judgement, so the list above is written down
 * rather than derived. What it has to reach is not: dropping a carried table empties every
 * current-schema child that cascades from it, and a child left out is gone with no row left
 * to say it was ever there. Retired tables are deliberately dropped and therefore do not
 * belong in the preservation check.
 */
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

/**
 * `sqlite3` has foreign keys off by default, so an order deleted by hand leaves
 * children pointing at nothing, and the restore below — which writes them back
 * with the keys on — would refuse the one command that can heal the database.
 * No source holds the order, so the children go with it rather than be repaired.
 */
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

/**
 * `CREATE TABLE IF NOT EXISTS` only ever adds, so a table `SCHEMA_SQL` has
 * stopped defining sits in every database that once ran the old statement with
 * nothing left to remove it. What belongs is read off `SCHEMA_SQL` so that
 * deleting the statement is the whole change, and FTS5 keeps its index in
 * tables named after the virtual table, which the schema never names itself.
 */
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
  // One of these can reference another, and the order they come back in is not
  // the order they can be dropped in; by the commit they are all gone.
  db.run("PRAGMA defer_foreign_keys = ON");
  for (const name of retired) db.run(`DROP TABLE IF EXISTS ${name}`);
  db.run("PRAGMA defer_foreign_keys = OFF");
  return retired;
}

/**
 * Columns are read off each table rather than listed here, because the reason
 * these are dropped at all is that `SCHEMA_SQL` holds a column they do not, and
 * a list in this file would be the one place still needing to be remembered. A
 * column the schema has dropped goes with the table; the rows keep the rest.
 * A column added `NOT NULL` with no default has no value to write for a row
 * saved before it existed. That refusal is named rather than guessed at: what
 * such a row should hold is the owner's to say, and inventing a placeholder
 * would put it in the record as though someone had meant it.
 */
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

/**
 * Everything here is re-read from the source files. Each table is dropped
 * rather than emptied, because `CREATE TABLE IF NOT EXISTS` leaves one that
 * already exists alone, so a column added to it would never appear and every
 * write of that column would throw. They go in dependency order: with foreign
 * keys on, a drop is an implicit delete, and a parent whose children are still
 * there fails.
 *
 * Which tables are left instead, and why, is stated at each of them in
 * `schema.ts`. `correction_label`, `hook_event` and the factory order records are
 * the ones that are neither: nothing can re-read them — the spool deletes each
 * file once it is read, and an order and its judgements were never in a source at
 * all — so they are dropped with the rest and written back row for row. A
 * table kept instead of dropped keeps whatever shape it was created with, and
 * a check widened in `SCHEMA_SQL` would never reach it.
 */
export function rebuild(db: Database, env: Env = process.env): RebuildReport {
  let orphans: OrphanReport[] = [];
  let retired: string[] = [];
  db.transaction(() => {
    const carried = carryThroughRebuild(db, FACTORY_ORDER_TABLES);
    orphans = carried.orphans;
    const restoreFactoryOrders = carried.restore;
    // Read out before the drop because no source can re-read them, and dropped
    // ahead of message because an older database has a foreign key to it that
    // would refuse that drop.
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
