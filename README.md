# dim-factory

Instrumentation for AI coding sessions on this machine, and the hooks that act inside them.

The name comes from [`docs/dark-factory.md`](docs/dark-factory.md): the engineering skills in `cniska/skills` form a production line — spec, plan, build, review, ship — and the question that note answers is not whether the line can run itself but at which gates removing the human costs more than it saves. Its answer is a dim factory, not a dark one: autonomous between the gates, a human at the gates that matter, and each gate earning its automation on its own merit.

Merit means evidence. This repo produces it.

## What it does

- **Collects.** Claude Code and Codex both record every session to disk. An incremental ingester reads both into one SQLite database — deterministic parsing and inserts, no model calls anywhere in the collection path.
- **Answers.** A small query CLI over that database: where loaded-skill context goes, which skills fire and by which path, where corrections cluster, what tokens and tools a session actually spends.
- **Guards.** Hooks that make mechanical what a skill can only instruct.

## Using it

Bun, pinned in `mise.toml`. `mise install && bun install`, then:

```
bun run dim sync            # read every new byte of both tools' session files
bun run dim stats           # row counts and token totals per tool and model
bun run dim rebuild         # forget every cursor and read all files from the start
bun run dim doctor          # check collection is working, and say what to fix
bun run dim install-hooks   # show the session hooks; --write applies them
bun run dim install-rules   # flatten the conventions into Codex's rules file
bun run dim install-skill   # show where the agent skills link; --write links them
bun run dim q list          # the named questions; `q <name>` asks one, --json for the raw rows
bun run verify              # lint, typecheck, test
```

`bun link` puts `dim` on PATH, which is what makes it usable from another repo — and an agent can only reach it from the repo it is working in.

Every query prints the base its numbers came from, and a query with nothing to report says so rather than printing a zero. Queries cover the last 30 days unless given `--since <n>d|YYYY-MM-DD` or `--all`; the window is printed with the numbers. Readers open the database read-only.

The database lands in `~/.local/share/dim-factory/sessions.db`. Reading the whole corpus from scratch takes about 20 seconds.

Claude Code deletes transcripts after 30 days unless told otherwise, so `~/.claude/settings.json` sets `"cleanupPeriodDays": 3650`. Without it the sources this points into disappear.

`dim doctor` checks the paths that fail silently: retention unset, hooks installed but never firing, a launchd agent written but never loaded, a spool nothing drains, a database built by an older schema. It reads only, exits non-zero when a check fails, and every failure names its fix.

`dim install-agent --write` writes a launchd agent that runs `dim sync` every 15 minutes, logging to `~/.local/share/dim-factory/sync.log`; load it with the `launchctl bootstrap` line the command prints. Re-run it after a toolchain change, since the plist names an absolute `bun`.

`dim install-rules --write` writes `~/.codex/AGENTS.md` from `~/.claude/CLAUDE.md` with every `@import` expanded. Claude Code expands those imports and Codex does not — a sentinel placed behind one reached Claude and never reached Codex — so a rules file that imports delivers its import line to Codex as literal text. A relative import resolves against the target tool's own directory, so `@RTK.md` picks up the Codex copy rather than the Claude one. `dim doctor` fails when the two drift.

`dim install-skill --write` links every skill under `skills/` into `~/.agents/skills` and `~/.codex/skills`. Claude and Acolyte both read the first by convention; Codex reads its own. `df-sessions` recovers what a past session said with `q search` and `q thread` instead of grepping transcripts; `df-delegate` decides whether work should leave a session for a subagent at all, and what to check when its answer comes back. They ship here rather than in the skills repo because those skills are tool-agnostic and these need `dim` installed.

The database holds every tool's sessions, so this is also how one tool reads what another did: a Claude session can recover a decision made in Codex, and the reverse. They share a record rather than a channel — neither has to be running for the other to read it.

`dim install-hooks --write` appends a `SessionStart`/`SessionEnd` hook to `~/.claude/settings.json` and `~/.codex/hooks.json`, keeping every hook already there and copying each file to `<file>.dim-backup` first. The hook is one redirect into a spool directory and always exits 0. It is worth running early: a transcript records no end marker, so until the hooks are in, a session that was abandoned cannot be told from one still open, and that gap cannot be filled in later.

## Publishing

The collector, the CLI, the queries and the skills under `skills/` are general: nothing in `src/` names a person or a machine, and paths print relative to whoever is reading. What is specific to this owner is the argument for building it ([`docs/dark-factory.md`](docs/dark-factory.md)), the measurements taken from one corpus ([`docs/findings.md`](docs/findings.md)), and the ten evidence citations in `docs/design.md` that point at files under one home directory. A split separates those, and it stays a `git mv` for as long as nothing personal lands in a general file.

Two portability gaps stand in the way of anyone else running it: `install-agent` writes a launchd plist, which is macOS only, and the collector reads two tools' formats.

## Layout

| Path | Holds |
|---|---|
| [`docs/design.md`](docs/design.md) | Schema, the questions it answers, ingestion, the read path, build order |
| [`docs/findings.md`](docs/findings.md) | What the corpus said when it was first asked, and what each number can carry |
| [`docs/evals-and-hooks.md`](docs/evals-and-hooks.md) | The hook install layout, and the eval instrument that measures whether a skill's rules earn their place |
| [`docs/goals.md`](docs/goals.md) | What the repo is for, in order: fewer corrections first, fewer tokens for the same work second |
| [`docs/loop.md`](docs/loop.md) | How a line gets cut and stays cut: what the corpus decides, what the evals decide, what is measured after |
| [`docs/dark-factory.md`](docs/dark-factory.md) | The argument this repo exists to execute |
| `src/parse-claude.ts`, `src/parse-codex.ts` | One source line to rows; neither knows the database exists |
| `src/ingest.ts` | Every upsert and the byte cursor; knows neither format |
| `src/cli.ts` | `dim` |

## Constraints

- No model calls in collection or backfill. A model reads query results when asked a question, never transcripts.
- The database stores structure and a locator into the source file. Tool results, file contents and thinking stay out of it.
- Ingestion is incremental and idempotent — re-running never double-counts, and an in-progress session ingests cleanly and updates later.
- Codex has equal standing with Claude Code, not a later phase.

## Related

- `cniska/skills` — the stations this measures. It consumes the query CLI the way `pr` consumes `gh`; nothing here is installed by `npx skills add`.
