# Session database

A local SQLite database, fed from the coding-agent sessions on this machine, that records what each session did and the commits that followed, so an agent or the owner can ask it instead of re-deriving the answer.

## Sources

Sessions are read from these files. Each one lands in the same tables.

- **Claude Code.** `~/.claude/projects/<slug>/<session-id>.jsonl`, one JSON object per line. Subagents are under `<session-id>/subagents/`. A subagent's session is `<agent id>@<parent session id>`, because an agent id repeats across parents.
- **Codex.** `~/.codex/sessions/**/rollout-*.jsonl` and `~/.codex/archived_sessions/`. The rollout is the source of record. Codex's own SQLite files are a projection of it, and only the rollout holds token usage.
- **Grok Build.** `~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl`. `summary.json` in that directory holds the title, working directory, branch, model, and parent. `GROK_HOME` overrides `~/.grok`. A child session is an ordinary session whose summary names its parent.

These are read too.

- **Prompt history.** `~/.claude/history.jsonl`, `~/.codex/history.jsonl`, and each Grok directory's `prompt_history.jsonl`. This is what remains when the transcript was deleted.
- **Hooks.** Events spooled by the hooks `dim` installs (see [Hooks](#hooks)).
- **Git.** `git log` of the repos the session rows name, into `repo_commit` and `commit_file`, and `git ls-files` into `repo_file`.

Claude Code deletes transcripts after 30 days unless `cleanupPeriodDays` is raised. This machine sets it to 3650. Codex does not prune. Grok removes a session when it is deleted. The database stores pointers into these files rather than archiving them, so a deleted source file loses whatever the database did not extract.

## What is stored

- **Stored as text** — user prompts, assistant text, rejection feedback, Bash command strings, the paths of edited files, and each skill body's hash and size.
- **Never stored** — tool results, file contents, diffs, stdout and stderr, thinking blocks, attachments and MCP results. A `message` row carries `src_file` and `src_line`, and a `tool_call` the lines of its call and result, so a question that needs the full record re-reads that line from the source.
- **Location** — `~/.local/share/dim-factory/`, holding `sessions.db`, the hook spool and the lock. Never inside a repository. Keep it out of cloud sync.

## Schema

[`src/db-schema.ts`](../src/db-schema.ts) is the schema, and each table carries the reason for its own shape beside it.

- **Every tool lands in the same tables.** A session records its `tool` from the vocabulary in [`src/ingest-tools.ts`](../src/ingest-tools.ts), and tool-specific detail goes in an `extra` JSON column, so a question about more than one needs no `UNION`. Times are ISO-8601 UTC text.
- **Tables are rebuilt by re-reading their sources**, so a schema change is `dim rebuild`, not a migration. `rebuild` drops the derived tables it names and recreates them from `SCHEMA_SQL`, since `CREATE TABLE IF NOT EXISTS` would leave an old shape in place.
- **Tables with no source to re-read survive it.** `hook_event` and the factory tables in `FACTORY_ORDER_TABLES` ([`src/ingest-sync.ts`](../src/ingest-sync.ts)) are dropped and written back row for row, so they can still take a schema change. Before dropping anything, `rebuild` refuses and lists every factory `table.column` the new shape cannot take: a column the schema no longer has that still holds values, or a required column that existing rows lack. A removed column holding only `NULL` values needs no repair, and neither does one the schema change names in `DISCARDED_COLUMNS` ([`src/db-schema.ts`](../src/db-schema.ts)), whose values it means to drop. Other reported columns are fixed by hand with `sqlite3` before running `rebuild` again. A table `rebuild` does not name, such as `guidance_walk` or `trace_event`, is left as it is.
- **`SCHEMA_VERSION` is bumped for a change only a re-read can correct** — a changed column, or a changed rule for what identifies a row. Until `rebuild` has finished and stamped the new version, `sync`, every other write and every reader refuse the database with `SCHEMA_TOO_OLD`, whichever side is newer. A reader checks before its first query ([`src/db-read.ts`](../src/db-read.ts)), and the wall shows the refusal as it shows any failed read. `dim doctor` alone reads any version, so it can report the drift and its repair.
- **A new table needs no bump**, because every write opens the database through `SCHEMA_SQL`, which creates it. That holds only until some database has run the statement; after that, changing its columns takes a bump ([`findings.md`](findings.md) has the case).
- [`src/db-schema-version.test.ts`](../src/db-schema-version.test.ts) pins the version beside a digest of `SCHEMA_SQL`, so every schema edit changes that line and two branches editing the schema conflict there.
- **Model identity is a column**, on `session`, `message`, `usage`, `tool_call`, `turn` and `skill_load`, kept verbatim as each surface reported it.
## Ingestion

```text
dim sync: drain the spool → read changed files → derive session ends
```

- **No network, credential or per-token cost, and no model reads a transcript.** Nothing is filtered or scored at ingest; deciding at read time is the only policy that is reversible.
- **Per-tool parsers** ([`src/ingest-parse-claude.ts`](../src/ingest-parse-claude.ts), [`src/ingest-parse-codex.ts`](../src/ingest-parse-codex.ts), [`src/ingest-parse-grok.ts`](../src/ingest-parse-grok.ts)) turn lines into rows and know nothing of the database; [`src/ingest.ts`](../src/ingest.ts) writes their rows and knows nothing of any format.
- **Another session source is one entry in [`src/ingest-sources.ts`](../src/ingest-sources.ts).** It lists session files and parses each into the same rows. Listing names the session and where it lives. Claude Code, Codex, and Grok Build are files, so each one is a [`FileSpec`](../src/ingest.ts) and a byte cursor. A source whose sessions are not files implements the same two steps without a path. The name is added to the vocabulary in [`src/ingest-tools.ts`](../src/ingest-tools.ts), which is what the schema checks. Prompt history, when the tool keeps one, is a path and a function that picks the session id, the time, and the text. A source does not require hooks or a harness.
- **Incremental.** `source_file.bytes_ingested` is each file's cursor, and a changed file is read from it. A file shorter than its cursor is re-ingested from zero in one transaction with the removal of what it wrote: its session row stays, so a subagent's link to it holds, and only the fields the transcript supplies are cleared and read again.
- **The cursor follows the session, not the path.** Codex archives a rollout by moving it, so the cursor is keyed by `(session_id, kind)` and `message.src_file` follows the new path through `ON UPDATE CASCADE`.
- **Idempotent.** Natural keys make a re-run a no-op: Claude `message.id` and `uuid`, tool-use ids, `response_id`, Codex item ids and `(thread_id, turn_id)`, Grok event ids and tool-call ids.
- **Claude usage is deduplicated and the largest kept.** One API response is written as one line per content block, each repeating `message.id` and a `usage` that accumulates as the response streams, so the line with the most output tokens holds the total.
- **Schedule.** `dim install-agent` writes a `launchd` agent that runs `dim sync` every 15 minutes, naming `bun` by absolute path because launchd starts with almost no environment. `dim rebuild` is `sync` with every cursor reset.
- **The lock** is a directory under the data directory that records its holder's pid, since macOS has no `flock` and a killed run would otherwise leave it held forever.

## Hooks

`dim install-hooks` installs a spool hook for each of Claude Code, Codex, and Grok Build whose executable is on `PATH` ([`src/hook-commands.ts`](../src/hook-commands.ts), [`src/hooks.ts`](../src/hooks.ts), [`src/harness-installed.ts`](../src/harness-installed.ts)). Claude Code and Codex also get `dim wake` on `SessionStart` and `dim format-edit` on `PostToolUse`, matched to their edit tools ([`src/format-edit.ts`](../src/format-edit.ts) `EDIT_TOOLS`) so no other tool call starts it. An installed hook whose command or matcher differs from the wanted one is stale and is rewritten in place.

| Event | What it does |
|---|---|
| `SessionStart` | spools the start source, model and harness pid from the hook's parent process. On Claude Code and Codex, `dim wake` prints declared repo commands and records the guidance in force |
| `SessionEnd` | spools the end time and reason, which a transcript lacks |
| `PostToolUse` | spools the tool call with its payload. On Claude Code and Codex, `dim format-edit` runs the repo's declared format task in the checkout an edit touched ([`src/format-edit.ts`](../src/format-edit.ts)), bounded and failing open. In a factory worker's session it runs nothing, since the worker wrote that manifest and the hook runs outside its sandbox; a builder formats inside its sandbox, and the runner's check holds the result |

Grok's file is `~/.grok/hooks/dim.json`. `GROK_HOME` overrides `~/.grok`. A Grok event names the session as `sessionId` and the event as `hookEventName` (`session_start`, `session_end`, `post_tool_use`). The model, when the event carries one, is `modelId`. The reader uses those when the Claude field names are absent.

- **The spool hook never opens the database.** It writes one file per event, so a session never waits on `sessions.db`; `sync` drains the spool into `hook_event`.
- **`hook_event` is never re-derived**, because a hook fires once. It has no foreign key to `session`, so an event that arrives before its transcript waits for it. A spool file that cannot be placed moves to `spool/unreadable/`, since it is the only copy. A drain is one transaction, and a file is deleted only once it has committed.
- **One source per column.** `session.ended_at` and `end_reason` come from `hook_event` alone, never from a transcript.
- **Concurrency.** `sync`, `rebuild` and a ship hold the lock. Other `dim` commands open their own connections in WAL mode. A write, including a transaction that reads before it writes, waits a bounded time for SQLite's write lock before failing with `SQLITE_BUSY` ([`src/db.ts`](../src/db.ts)); a trace waits less and drops its row ([`src/trace.ts`](../src/trace.ts)). A reader opens read-write under `query_only` ([`src/db-read.ts`](../src/db-read.ts)): a `readonly` connection fails with `SQLITE_CANTOPEN` on a WAL database whose `-wal` and `-shm` files are gone.
- **Codex is coarser.** Its `SessionEnd` reason is always `other` and it has no per-turn skill attribution, so tokens cannot be attributed to a skill within a Codex session.

## Tokens and cost

- **Tokens** come from `usage` only. Counts from different tools are never summed into one total, since they are not the same currency.
- **Cost** is stored only where the tool computed it. Claude writes that figure on `cost-state`. The database derives no dollar figure.

## Read path

- **`dim q <name>`** runs a named query; `dim q list` names them. Each is a `Query` in one of the modules [`src/query-registry.ts`](../src/query-registry.ts) imports.
- **One output shape.** Every command prints one line of JSON: `{command, ok, result}` on stdout, or `{command, ok: false, error}` on stderr with a `code` that tells errors apart ([`src/cli-output.ts`](../src/cli-output.ts)). A `raw` command prints the format its consumer parses instead: `wake`, `format-edit`, `check-command`, `trace`, `wt` and `comments check`.
- **A result states its base.** It carries `denominator`, `columns`, `rows` and `note`; an empty result says why, and a figure covering a subset names the subset.
- **Capped rows.** A result longer than 40 rows says how many were cut and names `--rows`.
- **Arguments are refused, not guessed.** A missing or malformed argument, an ambiguous prefix, a second positional or an unknown flag is a usage error; a prefix that matches nothing is an empty result that says so.
- **Read-only.** A query opens the database through `openReadOnly`, because `hook_event` has no source to restore it from. Its trace row goes through a separate connection.
- **A repository is named by its remote** — `owner/repo`, lowercased, host dropped — so worktrees and checkouts of one project share a label.
- **A scratch tree is not work.** [`src/ingest-scratch.ts`](../src/ingest-scratch.ts) excludes commits made under temp directories wherever session directories become repos.

## Search

- **Keywords.** `message_fts` is an FTS5 index over `message.text` with external content, kept level by triggers. `q search` unions one match per term and ranks by terms matched, then relevance, then recency. Each hit prints a full session ID and timestamp for `q thread`. Terms are quoted before they reach FTS5.

## What the record cannot say

- **Which instruction a model followed.** Structural compliance with a skill is an eval question, not a query.
- **Whether a skill caused an outcome.** A skill loads because of the kind of task, so skill-loaded against not-loaded comparisons are confounded and not built. Comparing one skill across its versions (`body_sha256`) is sound only as a pointer to sessions to read.
- **Whether a prompt was a correction.** Rejections and interruptions are recorded acts; whether a typed prompt told the agent it was wrong is semantic, and nothing in the record decides it.
- **Cross-model effects.** Model is on every row so a transition is observable, but a conclusion needs the same task run under both models.

## Key files

- `src/db-schema.ts` — tables, and the reason for each shape
- `src/ingest-sync.ts` — sync, rebuild and the tables carried through it
- `src/db.ts`, `src/db-read.ts`, `src/db-lock.ts` — opening the database, and the lock
- `src/ingest.ts`, `src/ingest-parse-claude.ts`, `src/ingest-parse-codex.ts`, `src/ingest-parse-grok.ts` — ingestion
- `src/ingest-spool.ts`, `src/hooks.ts` — hook spool and install
- `src/query-registry.ts`, `src/query-*.ts` — named queries
