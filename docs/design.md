# Session database

A local SQLite database, fed from the coding-agent sessions on this machine, that records what each session did and the commits that followed, so an agent or the owner can ask it instead of re-deriving the answer.

## Sources

Sessions are read from these files. Each one lands in the same tables.

- **Claude Code.** `~/.claude/projects/<slug>/<session-id>.jsonl`, one JSON object per line. Subagents are under `<session-id>/subagents/`. A subagent's session is `<agent id>@<parent session id>`, because an agent id repeats across parents.
- **Codex.** `~/.codex/sessions/**/rollout-*.jsonl` and `~/.codex/archived_sessions/`. The rollout is the source of record. Codex's own SQLite files are a projection of it, and only the rollout holds token usage. A session's title comes from `state_5.sqlite`, opened immutable: a read-only open of that WAL database fails once Codex has exited and removed its `-wal` and `-shm` files.
- **Grok Build.** `~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl`. `summary.json` in that directory holds the title, working directory, branch and parent. A child session is an ordinary session whose summary names its parent. Grok is read from its files only; `dim` installs no hook for it.
- **Pi and omp.** `~/.pi/agent/sessions/<encoded-cwd>/<time>_<session-id>.jsonl` and the same layout under `~/.omp`, omp being a fork of Pi that keeps its session format. One parser reads both; each is recorded under its own name. Read from their files only.

These are read too.

- **Hooks.** Events spooled by the hooks `dim` installs (see [Hooks](#hooks)).
- **Git.** `git log` of the repos the session rows name, into `repo_commit` and `commit_file`, and `git ls-files` into `repo_file`, through the one runner in [`src/git.ts`](../src/git.ts). A repo with no commits yet records nothing; one git cannot read is skipped and named in the sync report's `failures`.

Claude Code deletes transcripts after 30 days unless `cleanupPeriodDays` is raised. This machine sets it to 3650. Codex does not prune. Grok removes a session when it is deleted. The database stores pointers into these files rather than archiving them, so a deleted source file loses whatever the database did not extract.

## What is stored

- **Stored as text** — user prompts, assistant text, rejection feedback, Bash command strings, the paths of edited files, and each skill body's hash and size.
- **Never stored** — tool results, file contents, diffs, stdout and stderr, thinking blocks, attachments and MCP results. A `message` row carries `src_file` and `src_line`, and a `tool_call` the lines of its call and result, so a question that needs the full record re-reads that line from the source.
- **Location** — `record/` in the data directory ([paths](core.md#paths)), holding `sessions.db` and the hook spool. Never inside a repository. Keep it out of cloud sync.

## Schema

[`src/db-schema.ts`](../src/db-schema.ts) is the schema, the record's tables and the factory's in one statement under one version.

- **Every tool lands in the same tables.** A session records its `tool` from the vocabulary in [`src/ingest-tools.ts`](../src/ingest-tools.ts), which every `tool` column checks, so a question about more than one needs no `UNION`. Times are ISO-8601 UTC text.
- **What a table holds.**
  - A `message` is one row per Claude response, its content-block lines collapsed on `message.id`, and one per Codex `response_item` message.
  - A `tool_call` is written from its call and again from its result, and whichever lands second fills in what the first could not know.
  - A `git_command` is one git operation read from a shell command, so `git add -A && git commit` is one call and two rows. `tool_call.git_operation` is Claude's own metadata beside it, covering push, branch and PR only.
  - A `skill_load` says `how` the body arrived: `model` through the Skill tool, `user` by a typed `/name` or `$name`, `read` by opening `SKILL.md`, which is Codex's usual path.
  - A Claude `turn` is keyed by its `turn_duration` line and carries `message_count`. A Codex turn is written when it starts, with status `started` and no `ts_end`, and completed by the event that ends it, which carries `time_to_first_token_ms`.
  - `repo_commit.repo` is the git toplevel, one row per checkout, and `label` is the `owner/repo` the checkouts of one project share. `commit_file` is every path a commit touched; `repo_file` is what each repo tracks now, replaced on every sync, so a path from it opens. Both store absolute paths, to join a tool call's path on an index.
- **Tables are rebuilt by re-reading their sources**, so a schema change is `dim rebuild`, not a migration. `rebuild` drops every table and recreates them from `SCHEMA_SQL`, since `CREATE TABLE IF NOT EXISTS` would leave an old shape in place, and a table the schema no longer defines goes with them.
- **`hook_event` has no source to re-read**, so `rebuild` copies its rows aside and writes back the ones the current definition accepts. Its events are the list in [`src/hook-events.ts`](../src/hook-events.ts). The factory's tables are reset ([record versions](core.md#record-versions)).
- **`SCHEMA_VERSION` is bumped for a change only a re-read can correct** — a changed column, or a changed rule for what identifies a row. The version is the file's `PRAGMA user_version`. Until `rebuild` has finished and stamped the new version, `sync`, every other write and every reader refuse the database with `record_version`, whichever side is newer. A reader checks before its first query ([`src/db-read.ts`](../src/db-read.ts)), and the wall shows the refusal as it shows any failed read. `dim doctor` alone reads any version, so it can report the drift and its repair.
- **A new table needs no bump**, because every write opens the database through `SCHEMA_SQL`, which creates it. That holds only until some database has run the statement; after that, changing its columns takes a bump.
- [`src/db-schema-version.test.ts`](../src/db-schema-version.test.ts) pins the version beside a digest of `SCHEMA_SQL`, so every schema edit changes that line and two branches editing the schema conflict there.
- **Model identity is a column**, on `message`, `usage`, `tool_call`, `turn` and `skill_load`, kept verbatim as each surface reported it.

## Ingestion

```text
dim sync: drain the spool → read changed files → derive session ends
```

- **No network, credential or per-token cost, and no model reads a transcript.** Nothing is filtered or scored at ingest; deciding at read time is the only policy that is reversible.
- **Per-tool parsers** ([`src/ingest-parse-claude.ts`](../src/ingest-parse-claude.ts), [`src/ingest-parse-codex.ts`](../src/ingest-parse-codex.ts), [`src/ingest-parse-grok.ts`](../src/ingest-parse-grok.ts), [`src/ingest-parse-pi.ts`](../src/ingest-parse-pi.ts)) turn lines into rows and know nothing of the database; [`src/ingest.ts`](../src/ingest.ts) writes their rows and knows nothing of any format.
- **Another session source is one entry in [`src/ingest-sources.ts`](../src/ingest-sources.ts).** It lists session files and parses each into the same rows. Listing names the session and where it lives. Claude Code, Codex, Grok Build, Pi and omp are files, so each one is a [`FileSpec`](../src/ingest.ts) and a byte cursor. A source whose sessions are not files implements the same two steps without a path. The entry is keyed by its name in the vocabulary in [`src/ingest-tools.ts`](../src/ingest-tools.ts), which the schema checks, so a name without a source does not compile. A source does not require hooks or a harness.
- **Incremental.** `source_file.bytes_ingested` is each file's cursor, and a changed file is read from it. A file shorter than its cursor is re-ingested from zero in one transaction with the removal of what it wrote: its session row stays, so a subagent's link to it holds, and only the fields the transcript supplies are cleared and read again.
- **The cursor follows the session, not the path.** Codex archives a rollout by moving it, so the cursor is keyed by `(session_id, kind)` and `message.src_file` follows the new path through `ON UPDATE CASCADE`.
- **Idempotent.** Natural keys make a re-run a no-op: Claude `message.id` and `uuid`, tool-use ids, `response_id`, Codex item ids and `(thread_id, turn_id)`, Grok event ids and tool-call ids, Pi entry ids and tool-call ids.
- **Claude usage is deduplicated and the largest kept.** One API response is written as one line per content block, each repeating `message.id` and a `usage` that accumulates as the response streams, so the line with the most output tokens holds the total, and its row is replaced whole. A terminal `stop_reason` picks the same line for all but a sliver of responses, and each of those was interrupted and has no terminal line, so keying on it would drop them.
- **Schedule.** `dim agent install` writes a `launchd` agent that runs `dim sync` every 15 minutes, naming `bun` by absolute path because launchd starts with almost no environment. `dim rebuild` is `sync` with every cursor reset.
- **The lock** is a directory under the state directory's `locks/` that records its holder's pid, since macOS has no `flock` and a killed run would otherwise leave it held forever.

## Hooks

`dim hooks install` installs its hooks for each harness in `HARNESSES` ([`src/harness-contract.ts`](../src/harness-contract.ts)) whose executable is on `PATH`, into the config its entry names ([`src/hook-commands.ts`](../src/hook-commands.ts), [`src/hooks.ts`](../src/hooks.ts)): a spool hook on `SessionStart` and `SessionEnd`, `dim hooks start` on `SessionStart` and `dim hooks edit` on `PostToolUse`, matched to the harness's edit tools so no other tool call starts it. An installed hook whose command or matcher differs from the wanted one is stale and is rewritten in place. A hook dim installed and no longer wants is retired: install removes it, leaving any other hook in its entry, and `dim doctor` fails until it has.

| Event | What it does |
|---|---|
| `SessionStart` | spools the session's directory and the harness pid from the hook's parent process. `dim hooks start` prints declared repo commands |
| `SessionEnd` | spools the end time and reason, which a transcript lacks |
| `PostToolUse` | `dim hooks edit` runs the repo's declared format task in the checkout an edit touched ([`src/format-edit.ts`](../src/format-edit.ts)), bounded and failing open. In a factory worker's session it runs nothing, since the worker wrote that manifest and the hook runs outside its sandbox; a builder formats inside its sandbox, and the runner's check holds the result |
- **The spool hook never opens the database.** It writes one file per event, so a session never waits on `sessions.db`; `sync` drains the spool into `hook_event`.
- **`hook_event` is never re-derived**, because a hook fires once. It has no foreign key to `session`, so an event that arrives before its transcript waits for it. A spool file that cannot be placed moves to `spool/unreadable/`, since it is the only copy. A drain is one transaction, and a file is deleted only once it has committed.
- **One source per column.** `session.ended_at` and `end_reason` come from `hook_event` alone, never from a transcript.
- **Concurrency.** `sync`, `rebuild` and a ship hold the lock. Other `dim` commands open their own connections in WAL mode. A write, including a transaction that reads before it writes, waits a bounded time for SQLite's write lock before failing with `SQLITE_BUSY` ([`src/db.ts`](../src/db.ts)). A reader opens read-write under `query_only` ([`src/db-read.ts`](../src/db-read.ts)): a `readonly` connection fails with `SQLITE_CANTOPEN` on a WAL database whose `-wal` and `-shm` files are gone.
- **Codex is coarser.** Its `SessionEnd` reason is always `other` and it has no per-turn skill attribution, so tokens cannot be attributed to a skill within a Codex session.

## Tokens and cost

- **Tokens** come from `usage` only. Counts from different tools are never summed into one total, since they are not the same currency: `input_tokens` is stored as each tool reports it, which for Claude excludes cached reads and for Codex includes them.
- **No cost is stored**, and the database derives no dollar figure.

## Read path

- **`dim query <name>`** runs a named query; `dim query list` names them. Each is a `Query` in one of the modules [`src/query-registry.ts`](../src/query-registry.ts) imports.
- **One output shape.** Every command prints one line of JSON: `{command, ok, result}` on stdout, or `{command, ok: false, error}` on stderr ([`src/cli-output.ts`](../src/cli-output.ts)). An agent reads the error, so it carries a `code` to branch on, its facts as `meta`, a message naming its cause, and `resolve`, the `dim` command that resolves it ([`src/coded-error.ts`](../src/coded-error.ts) `refuser`). A usage error resolves with its command's usage. A broken assertion is a fault ([`src/assert.ts`](../src/assert.ts)): it prints with its own code like a refusal, but a station stops the turn on it instead of answering the worker, and a trace step records it as failed. An error with no code prints as `command_failed`, resolved by `dim doctor`. A `raw` command prints the format its consumer parses instead: `hooks start`, `hooks edit`, `trace`, and `gate` run by a git hook, which speaks to git through its exit code and stderr.
- **A result states its base.** It carries `denominator`, `columns`, `rows` and `note`; an empty result says why, and a figure covering a subset names the subset.
- **Capped rows.** A result longer than 40 rows says so and names `--rows`, the one cap on what a query returns. `search` reads one row past the cap and no further, since a common word matches most of the record.
- **Arguments are refused, not guessed.** A missing or malformed argument, an ambiguous prefix, a second positional or an unknown flag is a usage error; a prefix that matches nothing is an empty result that says so.
- **Read-only.** A query opens the database through `openReadOnly`, because `hook_event` has no source to restore it from.
- **A repository is named by its `origin` remote** — `owner/repo`, lowercased, host dropped — so worktrees and checkouts of one project share a label. A path under `<repo>/.claude/worktrees/<name>/` folds onto the checkout it copies ([`src/worktree.ts`](../src/worktree.ts)).
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
- `src/ingest.ts`, `src/ingest-parse-claude.ts`, `src/ingest-parse-codex.ts`, `src/ingest-parse-grok.ts`, `src/ingest-parse-pi.ts` — ingestion
- `src/ingest-spool.ts`, `src/hooks.ts` — hook spool and install
- `src/query-registry.ts`, `src/query-*.ts` — named queries
