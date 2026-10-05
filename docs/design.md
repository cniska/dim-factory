# Session database

A local SQLite database, fed from the coding-agent sessions on this machine, that records what each session did and the commits that followed, so an agent or the owner can ask it instead of re-deriving the answer.

## Sources

Sessions are read from these files. Each one lands in the same tables.

| Source | Files | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<session-id>.jsonl`, one JSON object per line; subagents under `<session-id>/subagents/` | A subagent's session is `<agent id>@<parent session id>`, because an agent id repeats across parents. A worker's turn-end copy, `<data>/workers/<name>/sessions/<session-id>.jsonl`, is read as a session too, attributed through `worker_session`; an id also under `~/.claude/projects` is read from that file alone, so each sync lists one file per id and the cursor does not alternate. The turn-end copy also holds the subagents, `<session-id>/subagents/agent-<id>.jsonl` and `.meta.json` beside it, read as `<agent id>@<parent>` sessions under the same one-file-per-id rule, keyed by that full id, never the agent id alone. It moves to the copy when the projects file is gone, and back when that file appears, continuing from the byte offset it held while the new file is at least that long, which is right only while it begins with what the old one held; a shorter file resets the session and is read again from its start |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` and `~/.codex/archived_sessions/` | The rollout is the source of record; Codex's own SQLite files are a projection of it, and only the rollout holds token usage. A session's title comes from `state_5.sqlite`, opened immutable, since a read-only open of that WAL database fails once Codex has removed its `-wal` and `-shm` files |
| Grok Build | `~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl`, with `summary.json` beside it holding the title, working directory, branch and parent | A child session is an ordinary session whose summary names its parent. Read from its files only; `dim` installs no hook for it |
| Pi and omp | `~/.pi/agent/sessions/<encoded-cwd>/<time>_<session-id>.jsonl`, and the same layout under `~/.omp` | omp is a fork of Pi that keeps its session format. One parser reads both, each recorded under its own name. Read from their files only |
| Hooks | Events the hooks `dim` installs drop in the [spool](#hooks) | |
| Git | `git log` of the repos the session rows name, into `repo_commit` and `commit_file`, and `git ls-files` into `repo_file`, through the one runner in [`src/git.ts`](../src/git.ts) | A repo with no commits yet records nothing; one git cannot read is skipped and named in the sync report's `failures` |

Claude Code deletes transcripts after 30 days unless `cleanupPeriodDays` is raised. Codex does not prune. Grok removes a session when it is deleted. The database stores pointers into these files rather than archiving them, so a deleted source file loses whatever the database did not extract.

## What is stored

| | |
|---|---|
| Stored as text | User prompts, assistant text, rejection feedback, Bash command strings, the paths of edited files, and each skill body's hash and size |
| Never stored | Tool results, file contents, diffs, stdout and stderr, thinking blocks, attachments and MCP results. A `message` row carries `src_file` and `src_line`, and a `tool_call` the lines of its call and result, so a question that needs the full record re-reads that line from the source |
| Location | `record/` in the data directory ([paths](core.md#paths)), holding `sessions.db` and the spool. Never inside a repository, and kept out of cloud sync |

## Schema

[`src/db-schema.ts`](../src/db-schema.ts) is the schema, the record's tables and the factory's in one statement under one version. A session records its `tool` from the vocabulary in [`src/ingest-tools.ts`](../src/ingest-tools.ts), which every `tool` column checks, so a question about more than one tool needs no `UNION`. Times are ISO-8601 UTC text, and model identity is a column on `message`, `usage`, `tool_call`, `turn` and `skill_load`, kept verbatim as each surface reported it.

| Table | Holds |
|---|---|
| `message` | One row per Claude response, its content-block lines collapsed on `message.id`, and one per Codex `response_item` message |
| `tool_call` | One call, written from its call and again from its result; whichever lands second fills in what the first could not know |
| `git_command` | One git operation read from a shell command, so `git add -A && git commit` is one call and two rows. `tool_call.git_operation` is Claude's own metadata beside it, covering push, branch and PR only |
| `skill_load` | How a skill body arrived: `model` through the Skill tool, `user` by a typed `/name` or `$name`, `read` by opening `SKILL.md`, which is Codex's usual path |
| `turn` | A Claude turn keyed by its `turn_duration` line, carrying `message_count`. A Codex turn is written when it starts, with status `started` and no `ts_end`, and completed by the event that ends it, which carries `time_to_first_token_ms` |
| `repo_commit` | One row per commit sha, its `repo` the checkout that last synced it and its `label` the `owner/repo` the checkouts of one project share |
| `commit_file`, `repo_file` | Every path a commit touched, and what each repo tracks now, replaced on every sync so a path from it opens. Both store absolute paths, to join a tool call's path on an index |

How the schema changes:

| Rule | What holds |
|---|---|
| A rebuild, not a migration | Tables are rebuilt by re-reading their sources, so a schema change is `dim rebuild`. It drops every table and recreates them from `SCHEMA_SQL`, since `CREATE TABLE IF NOT EXISTS` would leave an old shape in place, and a table the schema no longer defines goes with them |
| `hook_event` is carried | It has no source to re-read, so `rebuild` copies its rows aside and writes back the ones the current definition accepts. Its events are the list in [`src/hook-events.ts`](../src/hook-events.ts). The factory's tables are reset ([record versions](core.md#record-versions)) |
| A bump for what only a re-read corrects | `SCHEMA_VERSION`, the file's `PRAGMA user_version`, changes for a changed column or a changed rule for what identifies a row. Until `rebuild` has stamped the new version, `sync`, every other write and every reader refuse the database with `record_version`, whichever side is newer. A reader checks before its first query ([`src/db-read.ts`](../src/db-read.ts)); `dim doctor` alone reads any version, so it can report the drift and its repair |
| No bump for a new table or index | Every write opens the database through `SCHEMA_SQL`, which creates it. That holds only until some database has run the statement; after that, changing its columns takes a bump |
| The version is pinned | [`src/db-schema-version.test.ts`](../src/db-schema-version.test.ts) pins it beside a digest of `SCHEMA_SQL`, so every schema edit changes that line and two branches editing the schema conflict there |
| Every foreign key leads an index | Deleting or dropping the rows it references never scans the referencing table ([`src/db-schema.test.ts`](../src/db-schema.test.ts)). A rebuild drops its tables with foreign keys off, since nothing references a table that is going |

## Ingestion

```text
dim sync: drain the spool → read changed files → derive session ends
```

No network, credential or per-token cost, and no model reads a transcript. Nothing is filtered or scored at ingest; deciding at read time is the only policy that is reversible.

| Rule | What holds |
|---|---|
| Parsers know no database | Each tool's parser ([`src/ingest-parse-claude.ts`](../src/ingest-parse-claude.ts), [`src/ingest-parse-codex.ts`](../src/ingest-parse-codex.ts), [`src/ingest-parse-grok.ts`](../src/ingest-parse-grok.ts), [`src/ingest-parse-pi.ts`](../src/ingest-parse-pi.ts)) turns lines into rows; [`src/ingest.ts`](../src/ingest.ts) writes them and knows no format |
| A source is one entry | Another session source is one entry in [`src/ingest-sources.ts`](../src/ingest-sources.ts): it lists session files, naming each session and where it lives, and parses each into the same rows. A file-based source is a [`FileSpec`](../src/ingest.ts) and a byte cursor; one whose sessions are not files implements the same two steps without a path. The entry is keyed by its name in [`src/ingest-tools.ts`](../src/ingest-tools.ts), which the schema checks, so a name without a source does not compile. A source needs no hooks and no harness |
| Incremental | `source_file.bytes_ingested` is each file's cursor, and a changed file is read from it. A file shorter than its cursor is re-ingested from zero in one transaction with the removal of what it wrote: its session row stays, so a subagent's link to it holds |
| The cursor follows the session | Codex archives a rollout by moving it, so the cursor is keyed by `(session_id, kind)` and `message.src_file` follows the new path through `ON UPDATE CASCADE` |
| Idempotent | Natural keys make a re-run a no-op: Claude `message.id` and `uuid`, tool-use ids, `response_id`, Codex item ids and `(thread_id, turn_id)`, Grok event ids and tool-call ids, Pi entry ids and tool-call ids |
| Claude usage keeps the largest | One API response is one line per content block, each repeating `message.id` and a `usage` that accumulates as it streams, so the line with the most output tokens holds the total and its row is replaced whole. Keying on a terminal `stop_reason` would drop the interrupted responses that have none |
| Schedule | `dim agent install` writes a `launchd` agent that runs `dim sync` every 15 minutes, naming `bun` by absolute path because launchd starts with almost no environment. `dim rebuild` is `sync` with every cursor reset |
| The lock | A directory under the state directory's `locks/` that records its holder's pid, since macOS has no `flock` and a killed run would otherwise leave it held forever |

## Hooks

`dim hooks install` installs its hooks for each harness in `HARNESSES` ([`src/harness-contract.ts`](../src/harness-contract.ts)) whose executable is on `PATH`, into the config its entry names ([`src/hook-commands.ts`](../src/hook-commands.ts), [`src/hooks.ts`](../src/hooks.ts)). An installed hook whose command or matcher differs from the wanted one is stale and is rewritten in place. A hook dim installed and no longer wants is retired: install removes it, leaving any other hook in its entry, and `dim doctor` fails until it has. A hook config, or a Codex `config.toml`, whose hooks hold the wrong shape is refused `config_invalid`, naming the file and the path to the bad value, rather than half-read.

| Event | What it does |
|---|---|
| `SessionStart` | The spool hook records the session's directory and the harness pid from the hook's parent process. `dim hooks start` prints the repo's declared commands |
| `SessionEnd` | The spool hook records the end time and reason, which a transcript lacks |
| `PostToolUse` | `dim hooks edit`, matched to the harness's edit tools, runs the repo's declared format task in the checkout an edit touched ([`src/format-edit.ts`](../src/format-edit.ts)), bounded and failing open. In a factory worker's session it runs nothing, since the worker wrote that manifest and the hook runs outside its sandbox; the slice gate's check holds the result |

| Rule | What holds |
|---|---|
| A hook never stops a session | `dim hooks start` and `dim hooks edit` refuse a payload without the session's `cwd`, and their installed lines end in `2>/dev/null \|\| true`; the spool hook exits 0 itself |
| The spool hook never opens the database | It writes one file per event to the spool, so a session never waits on `sessions.db`; `sync` drains the spool into `hook_event` |
| `hook_event` is never re-derived | A hook fires once. The table has no foreign key to `session`, so an event that arrives before its transcript waits for it. A spool file that cannot be placed moves to `spool/unreadable/`, since it is the only copy. A drain is one transaction, and a file is deleted only once it has committed |
| One source per column | `session.ended_at` and `end_reason` come from `hook_event` alone, never from a transcript |
| Concurrency | `sync`, `rebuild` and a ship hold the lock. Other commands open their own connections in WAL mode. A write, including a transaction that reads before it writes, waits a bounded time for SQLite's write lock before failing with `SQLITE_BUSY` ([`src/db.ts`](../src/db.ts)). A reader opens read-write under `query_only` ([`src/db-read.ts`](../src/db-read.ts)), since a `readonly` connection fails with `SQLITE_CANTOPEN` on a WAL database whose `-wal` and `-shm` files are gone |
| Codex is coarser | Its `SessionEnd` reason is always `other` and it has no per-turn skill attribution, so tokens cannot be attributed to a skill within a Codex session |

## Tokens and cost

Tokens come from `usage` only. Counts from different tools are never summed into one total, since they are not the same currency: `input_tokens` is stored as each tool reports it, which for Claude excludes cached reads and for Codex includes them. No cost is stored, and the database derives no dollar figure.

## Read path

| Rule | What holds |
|---|---|
| Named queries | `dim query <name>` runs one; `dim query list` names them. Each is a `Query` in one of the modules [`src/query-registry.ts`](../src/query-registry.ts) imports |
| One output shape | Every command prints one line of JSON: `{command, ok, result}` on stdout, or `{command, ok: false, error}` on stderr ([`src/cli-output.ts`](../src/cli-output.ts)). The error carries a `code` to branch on, its facts as `meta`, a message naming its cause, and `resolve`: the command that resolves it, or, when none does, to stop and hand the error to the owner, never `dim doctor` ([`src/coded-error.ts`](../src/coded-error.ts) `refuser`). A usage error resolves with its command's usage. A broken assertion is a fault ([`src/assert.ts`](../src/assert.ts)): it prints with its own code, but a station stops the turn on it instead of answering the worker, and a trace step records it as failed. An error with no code prints as `command_failed` and is handed to the owner as a bug. A `raw` command prints the format its consumer parses instead: `hooks start`, `hooks edit` and `trace` |
| A result states its base | It carries `denominator`, `rows`, `more` and `note`, and a named query its `columns` too; an empty result says why, and a figure covering a subset names the subset |
| Capped rows | A result longer than 40 rows says so and names `--rows`, the one cap on what a query returns. `search` and `dim sql` read one row past the cap and no further, and `dim sql` says there are more than the cap rather than counting them |
| Arguments are refused, not guessed | A missing or malformed argument, an ambiguous prefix, a second positional or an unknown flag is a usage error; a prefix that matches nothing is an empty result that says so |
| Read-only | A query opens the database through `openReadOnly`, because `hook_event` has no source to restore it from |
| A repository is its `origin` | `owner/repo`, lowercased, host dropped, so worktrees and checkouts of one project share a label. A path under `<repo>/.claude/worktrees/<name>/` folds onto the checkout it copies ([`src/worktree.ts`](../src/worktree.ts)) |
| A scratch tree is not work | [`src/ingest-scratch.ts`](../src/ingest-scratch.ts) excludes commits made under temp directories wherever session directories become repos; a factory workspace (`isFactoryWorkspace`, a resolved path under the data directory's `workspaces/`) is no repo root either, because its commits reach the checkout on ship |
| Keyword search | `message_fts` is an FTS5 index over `message.text` with external content, kept level by triggers. `dim query search` quotes each term, unions one match per term and ranks by terms matched, then relevance, then recency; each hit prints a full session ID and timestamp for `dim query thread` |

## What the record cannot say

| Question | Why not |
|---|---|
| Which instruction a model followed | Structural compliance with a skill is an eval question, not a query |
| Whether a skill caused an outcome | A skill loads because of the kind of task, so skill-loaded against not-loaded comparisons are confounded and not built. Comparing one skill across its versions (`body_sha256`) is sound only as a pointer to sessions to read |
| Whether a prompt was a correction | Rejections and interruptions are recorded acts; whether a typed prompt told the agent it was wrong is semantic, and nothing in the record decides it |
| Cross-model effects | Model is on every row so a transition is observable, but a conclusion needs the same task run under both models |
