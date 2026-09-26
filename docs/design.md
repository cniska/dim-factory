# Session database

A local SQLite database, fed from Claude Code and Codex on this machine, that records what each session did and the commits that followed, so an agent or the owner can ask it instead of re-deriving the answer.

## Sources

- **Claude Code transcripts** — `~/.claude/projects/<slug>/<session-id>.jsonl`, one JSON object per line, with subagents under `<session-id>/subagents/`. A subagent's session is `<agent id>@<parent session id>`, because an agent id repeats across parents.
- **Codex rollouts** — `~/.codex/sessions/**/rollout-*.jsonl` and `~/.codex/archived_sessions/`. The rollout is the source of record; Codex's own SQLite files are a projection of it, and only the rollout holds token usage.
- **Prompt history** — `~/.claude/history.jsonl` and `~/.codex/history.jsonl`, the only remnant of a session whose transcript was deleted.
- **Hooks** — events spooled by the hooks `dim` installs (see [Hooks](#hooks)).
- **Git** — `git log` of the repos the session rows name, read into `repo_commit` and `commit_file`, and `git ls-files` into `repo_file`.

Claude Code deletes transcripts after 30 days unless `cleanupPeriodDays` is raised; this machine sets it to 3650, and Codex never prunes. The database stores pointers into these files rather than archiving them, so a deleted source file loses whatever the database did not extract.

## What is stored

- **Stored as text** — user prompts, assistant text, rejection feedback, Bash command strings, the paths of edited files, and each skill body's hash and size.
- **Never stored** — tool results, file contents, diffs, stdout and stderr, thinking blocks, attachments and MCP results. A `message` row carries `src_file` and `src_line`, and a `tool_call` the lines of its call and result, so a question that needs the full record re-reads that line from the source.
- **Location** — `~/.local/share/dim-factory/`, holding `sessions.db`, the hook spool and the lock. Never inside a repository. Keep it out of cloud sync.

## Schema

[`src/db-schema.ts`](../src/db-schema.ts) is the schema, and each table carries the reason for its own shape beside it.

- **Both tools land in the same tables.** A session records its `tool`, `claude` or `codex`, and tool-specific detail goes in an `extra` JSON column, so a question about both needs no `UNION`. Times are ISO-8601 UTC text.
- **Tables are rebuilt by re-reading their sources**, so a schema change is `dim rebuild`, not a migration. `rebuild` drops the derived tables it names and recreates them from `SCHEMA_SQL`, since `CREATE TABLE IF NOT EXISTS` would leave an old shape in place.
- **Tables with no source to re-read survive it.** `correction_label`, `hook_event` and the factory tables ([`src/ingest-sync.ts`](../src/ingest-sync.ts)) are dropped and written back row for row, so they can still take a schema change. A table `rebuild` does not name, such as `guidance_walk`, `trace_event`, `finding` or `embedding`, is left as it is.
- **`SCHEMA_VERSION` is bumped for a change only a re-read can correct** — a changed column, or a changed rule for what identifies a row. Until `rebuild` has finished and stamped the new version, `sync` and every other write refuse the database.
- **A new table needs no bump**, because every write opens the database through `SCHEMA_SQL`, which creates it. That holds only until some database has run the statement; after that, changing its columns takes a bump ([`findings.md`](findings.md) has the case).
- [`src/db-schema-version.test.ts`](../src/db-schema-version.test.ts) pins the version beside a digest of `SCHEMA_SQL`, so every schema edit changes that line and two branches editing the schema conflict there.
- **Model identity is a column**, on `session`, `message`, `usage`, `tool_call`, `turn` and `skill_load`, kept verbatim as each surface reported it.
- **A finding is keyed on the repo and the file**, not the session, because the question it answers is whether a later fix came back to flagged code. It is never a score on the builder.

## Ingestion

```text
dim sync: drain the spool → read changed files → derive session ends
```

- **No network, credential or per-token cost, and no model reads a transcript.** Nothing is filtered or scored at ingest; deciding at read time is the only policy that is reversible.
- **Per-tool parsers** ([`src/ingest-parse-claude.ts`](../src/ingest-parse-claude.ts), [`src/ingest-parse-codex.ts`](../src/ingest-parse-codex.ts)) turn lines into rows and know nothing of the database; [`src/ingest.ts`](../src/ingest.ts) writes their rows and knows nothing of either format.
- **Incremental.** `source_file.bytes_ingested` is each file's cursor, and a changed file is read from it. A file shorter than its cursor is re-ingested from zero.
- **The cursor follows the session, not the path.** Codex archives a rollout by moving it, so the cursor is keyed by `(session_id, kind)` and `message.src_file` follows the new path through `ON UPDATE CASCADE`.
- **Idempotent.** Natural keys make a re-run a no-op: Claude `message.id` and `uuid`, tool-use ids, `response_id`, Codex item ids and `(thread_id, turn_id)`.
- **Claude usage is deduplicated and the largest kept.** One API response is written as one line per content block, each repeating `message.id` and a `usage` that accumulates as the response streams, so the line with the most output tokens holds the total.
- **Schedule.** `dim install-agent` writes a `launchd` agent that runs `dim sync` every 15 minutes, naming `bun` by absolute path because launchd starts with almost no environment. `dim rebuild` is `sync` with every cursor reset.
- **The lock** is a directory under the data directory that records its holder's pid, since macOS has no `flock` and a killed run would otherwise leave it held forever.

## Hooks

`dim install-hooks` installs these for both tools ([`src/hooks.ts`](../src/hooks.ts)):

| Event | What it records |
|---|---|
| `SessionStart` | the start source and model, spooled; and `dim wake`, which delivers recall and records the guidance in force |
| `SessionEnd` | the end time and reason, which a transcript lacks |
| `PostToolUse` | that a tool call happened, with its payload |

- **The spool hook never opens the database.** It writes one file per event and exits 0, so a session never waits on `sessions.db`; `sync` drains the spool into `hook_event`.
- **`hook_event` is never re-derived**, because a hook fires once. It has no foreign key to `session`, so an event that arrives before its transcript waits for it. A spool file that cannot be placed moves to `spool/unreadable/`, since it is the only copy.
- **One source per column.** `session.ended_at` and `end_reason` come from `hook_event` alone, never from a transcript.
- **Concurrency.** `sync`, `rebuild`, `embed` and a ship hold the lock. Other `dim` commands open their own connections in WAL mode, and a writer waits a bounded time for SQLite's write lock before failing with `SQLITE_BUSY` ([`src/db.ts`](../src/db.ts)); a trace waits less and drops its row ([`src/trace.ts`](../src/trace.ts)).
- **Codex is coarser.** Its `SessionEnd` reason is always `other` and it has no per-turn skill attribution, so tokens cannot be attributed to a skill within a Codex session.

## Tokens and cost

- **Tokens** come from `usage` only, and the two tools' counts are never summed into one total, since they are not the same currency.
- **Cost** is stored only where the tool computed it — Claude's `cost-state`. Codex reports none, and the database derives no dollar figure.

## Read path

- **`dim q <name>`** runs a named query; `dim q list` names them. Each is a `Query` in one of the modules [`src/query-registry.ts`](../src/query-registry.ts) imports.
- **One output shape.** Every command prints one line of JSON: `{command, ok, result}` on stdout, or `{command, ok: false, error}` on stderr with a `code` that tells errors apart ([`src/cli-output.ts`](../src/cli-output.ts)). A `raw` command prints the format its consumer parses instead: `wake`, `check-command`, `trace`, `wt`, `operator` and `comments check`.
- **A result states its base.** It carries `denominator`, `columns`, `rows` and `note`; an empty result says why, and a figure covering a subset names the subset.
- **Capped rows.** A result longer than 40 rows says how many were cut and names `--rows`.
- **A 30-day window** by default, moved with `--since` and removed with `--all`, and stated in the denominator. Time series and queries about a named thing are unwindowed.
- **Read-only.** A query opens the database through `openReadOnly`, so a wrong query cannot touch `hook_event`, which has no source to restore it from. Its trace row goes through a separate connection.
- **A repository is named by its remote** — `owner/repo`, lowercased, host dropped — so worktrees and checkouts of one project share a label.
- **A scratch tree is not work.** [`src/ingest-scratch.ts`](../src/ingest-scratch.ts) excludes commits made under temp directories wherever session directories become repos.

## Search

- **Keywords.** `message_fts` is an FTS5 index over `message.text` with external content, kept level by triggers. `keywords` unions one match per term and ranks by terms matched, then relevance, then recency. Terms are quoted before they reach FTS5.
- **Meaning.** `embedding` holds one 384-float unit vector per distilled passage — a handoff's `## Next`, a commit subject, a labeled correction — with its text beside it. `q search` scores every vector with a dot product; there is no vector store. Where nothing is embedded, it answers from `message_fts` and says so.
- **Re-embedding** is keyed on `text_sha` and `model`, so only changed passages are embedded again.
- **Benchmark.** `dim bench` reads `retrieval.jsonl` from the data directory, runs each question through the query it names, and reports recall@k and nDCG@k ([`src/bench-rank-metrics.ts`](../src/bench-rank-metrics.ts)). A line is `{"id", "query", "question", "relevant": [{"ref", "grade"}]}`, where a ref is a commit sha, a session id, or `<session id>@<timestamp>`. The corpus stays out of this repo because its questions name the owner's work.

## What the record cannot say

- **Which instruction a model followed.** Structural compliance with a skill is an eval question, not a query.
- **Whether a skill caused an outcome.** A skill loads because of the kind of task, so skill-loaded against not-loaded comparisons are confounded and not built. Comparing one skill across its versions (`body_sha256`) is sound only as a pointer to sessions to read.
- **Whether a prompt was a correction.** Rejections and interruptions are recorded acts; whether a typed prompt told the agent it was wrong is left to `correction_label`, written by a person or a model asked deliberately.
- **Cross-model effects.** Model is on every row so a transition is observable, but a conclusion needs the same task run under both models.

## Key files

- `src/db-schema.ts` — tables, and the reason for each shape
- `src/ingest-sync.ts` — sync, rebuild and the tables carried through it
- `src/db.ts`, `src/db-read.ts`, `src/db-lock.ts` — opening the database, and the lock
- `src/ingest.ts`, `src/ingest-parse-claude.ts`, `src/ingest-parse-codex.ts` — ingestion
- `src/ingest-spool.ts`, `src/hooks.ts` — hook spool and install
- `src/query-registry.ts`, `src/*-queries.ts` — named queries
- `src/search-embed.ts`, `src/bench.ts` — embeddings and the retrieval benchmark
