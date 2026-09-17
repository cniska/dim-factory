# dim-factory

A software factory run by coding agents, with a human at the gates that still earn one.

The stations are the engineering skills in `cniska/skills` — spec, plan, build, review, ship — each with an entry contract and an exit check, and the floor that runs them is a coding agent. What lives here is the rest of it: the record of what every session did, the questions asked of that record, and the gates that hold a rule whether or not a skill loaded.

[`docs/factory.md`](docs/factory.md) is the argument. The question is not whether the line can run itself but at which gates removing the human costs more than it saves, and the answer is a dim factory rather than a dark one: autonomous between the gates, a human at the gates that matter, and each gate earning its automation on its own merit.

Merit means evidence, so the factory measures itself. [`docs/goals.md`](docs/goals.md) states what it is measured against.

## What it does

- **Collects.** Claude Code and Codex both record every session to disk. An incremental ingester reads both into one SQLite database — deterministic parsing and inserts, no model calls anywhere in the collection path.
- **Answers.** A small query CLI over that database: where loaded-skill context goes, which skills fire and by which path, where corrections cluster, what tokens and tools a session actually spends.
- **Guards.** Hooks that make mechanical what a skill can only instruct.
- **Installs.** One copy of the tooling every checkout needs — `wt`, the commit-subject gate, the flattened rules, the sync agent — linked or pointed at from each repo rather than copied into it, so what runs cannot drift from what is tested here. A script that a third checkout would have to port belongs here instead; the same file under two repos has already diverged every time ([`docs/findings.md`](docs/findings.md)).

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
bun run dim install-commit-gate --owner=<owner>  # one commit-subject gate for every repo; --write installs
bun run dim install-wt      # link wt onto PATH; --write applies it
bun run dim wake            # what the last session here left as Next, for the SessionStart hook
bun run dim q chain [id]    # which sessions were one piece of work, joined by the handoff between them
bun run dim q prior-art "<path>"   # how the same problem was solved in the repos already on disk
bun run dim check-commits <range>  # judge a revision range by the same rules the gate holds
bun run dim sql "<select>"  # one read-only statement, for a question no named query covers
bun run dim q list          # the named questions; `q <name>` asks one, --json for the raw rows
bun run verify              # lint, typecheck, test
```

`bun link` puts `dim` on PATH, which is what makes it usable from another repo — and an agent can only reach it from the repo it is working in.

`dim sql "<select>"` runs one statement against the same read-only connection the queries use, so a question no named query covers does not mean leaving the tool. A statement that writes is refused by SQLite rather than by a rule here, which would have to be right about every spelling of a write. The named questions are grown from this: a question worth asking twice becomes one of them.

Every query prints the base its numbers came from, and a query with nothing to report says so rather than printing a zero. Queries cover the last 30 days unless given `--since <n>d|YYYY-MM-DD` or `--all`; the window is printed with the numbers. Readers open the database read-only.

The database lands in `~/.local/share/dim-factory/sessions.db`. Reading the whole corpus from scratch takes about 20 seconds.

`sync` reads past a complete line that is not JSON rather than refusing the file, which is what stops one corrupt record from stalling collection. The cursor advances over it, so that sync is the only one that can ever name it: it prints the file and the line number to stderr, and the launchd agent's `sync.log` is where that lands. `dim rebuild` reads the file from the start and reports it again.

Claude Code deletes transcripts after 30 days unless told otherwise, so `~/.claude/settings.json` sets `"cleanupPeriodDays": 3650`. Without it the sources this points into disappear.

`dim doctor` checks the paths that fail silently: retention unset, hooks installed but never firing, a launchd agent written but never loaded, a spool nothing drains, a commit gate covering no repo, a database built by an older schema. It reads only, exits non-zero when a check fails, and every failure names its fix.

`dim install-agent --write` writes a launchd agent that runs `dim sync` every 15 minutes, logging to `~/.local/share/dim-factory/sync.log`; load it with the `launchctl bootstrap` line the command prints. Re-run it after a toolchain change, since the plist names an absolute `bun`.

`dim install-rules --write` writes `~/.codex/AGENTS.md` from `~/.claude/CLAUDE.md` with every `@import` expanded. Claude Code expands those imports and Codex does not — a sentinel placed behind one reached Claude and never reached Codex — so a rules file that imports delivers its import line to Codex as literal text. A relative import resolves against the target tool's own directory, so `@RTK.md` picks up the Codex copy rather than the Claude one. `dim doctor` fails when the two drift.

`dim install-skill --write` links every skill under `skills/` into `~/.agents/skills` and `~/.codex/skills`. Claude and Acolyte both read the first by convention; Codex reads its own. `df-sessions` recovers what a past session said with `q search` and `q thread` instead of grepping transcripts; `df-delegate` decides whether work should leave a session for a subagent at all, and what to check when its answer comes back. They ship here rather than in the skills repo because those skills are tool-agnostic and these need `dim` installed.

The database holds every tool's sessions, so this is also how one tool reads what another did: a Claude session can recover a decision made in Codex, and the reverse. They share a record rather than a channel — neither has to be running for the other to read it.

`dim install-commit-gate --owner=<owner> --write` writes one `commit-msg` hook to `~/.config/dim/hooks/` and points git's global `core.hooksPath` at it, so every repo shares a single copy and a rule fixed once is fixed everywhere. A repo that sets its own `core.hooksPath` keeps the hooks it has, because git resolves that setting locally before globally. Where the global setting is already pointed somewhere else — a managed install does this — the command refuses and names it, before writing the hook or clearing a single per-repo copy: git reads one hooks directory and merges nothing, so proceeding would disable whatever was there. Ownership is checked when the hook runs rather than when it is installed: a clone of someone else's project keeps its own conventions, and a repo cloned later is covered without reinstalling. The hook holds the convention in `~/.claude/CLAUDE.md` — Conventional Commits, a single-line subject of at most 50 characters, ASCII, no body — and is self-contained bash that exits 0 on anything it cannot read, because it runs before every commit on the machine.

`dim install-wt --write` links [`scripts/wt`](scripts/wt) onto PATH. `wt` makes one worktree per task at `<repo>/.claude/worktrees/<branch>`, runs the repo's `scripts/worktree-setup.sh` on creation and `scripts/worktree-teardown.sh` before removal, and keeps the branch so the work can still be merged. It lives here because this is the repo that already reads its convention ([`src/worktree.ts`](src/worktree.ts)); linking rather than copying is what stops the script on PATH from drifting from the one `bun run verify` tests, and whatever was there is renamed to `.dim-backup` rather than removed. See [`docs/worktrees.md`](docs/worktrees.md).

`dim wake` prints the Next left by the last session that worked in this directory, and `install-hooks` wires it to `SessionStart` on both tools. That is the only channel here reaching a session without anyone deciding to ask: Claude Code adds a SessionStart hook's plain-text stdout to the session as context the model can act on, and Codex takes the same block as `hookSpecificOutput.additionalContext`, which is why `--tool=` picks the envelope. It carries a handoff's `## Next` and nothing else a query can answer, because the block costs tokens in every session that starts here; where the last session left no Next it prints nothing at all. The text comes from the transcript rather than the file, since a handoff is printed before it is pasted, and a message counts as one when it carries the heading and a Next that parses — a quarter of the handoffs in the corpus were written under no skill, so the `handoff` attribution cannot be the test.

The wake hook is the one hook here that speaks rather than records, so it is the one that can waste tokens: it runs before every session, and what it prints is paid for in every session that starts. `dim q skill handoff` measures whether it pays.

`dim q chain [id-prefix]` answers which sessions were one piece of work. A handoff is printed into one transcript and pasted into the next, so `sync` joins the two on the heading line and writes an edge per paste into `handoff_link`; where a title was reused, the writer is the nearest preceding printer in another session. Without an argument it groups the edges by title, ranking the tasks that spanned the most sessions; with one it walks the edge in both directions from that session, so it crosses a task that was renamed midway and branches where one handoff was pasted into two sessions. Around one paste in five finds no writer, because that transcript was pruned before it was ever read. The table is derived and replaced whole on every sync, so a link exists only while both messages do.

`dim q prior-art "<path fragment>"` answers how the same problem was solved before: every tracked file whose path matches, across the repos the corpus names, dated by the commits that touched it. It reads `repo_file`, which `sync` replaces whole from `git ls-files` on every run, so every path it prints opens — `commit_file` records what a repo once held, where a rename is a delete and an add and a file deleted years ago still has its rows. Worktrees fold onto the file they are a copy of, and at most three files come from any one repo, so a repo with fifty workflows cannot be the whole answer. It ranks by recency and commit count, which is not quality.

`dim check-commits <range>` judges every authored subject in a revision range by `checkSubject`, the same function the installed hook's rules mirror, and names each commit and the rule it broke. CI runs it over what each push added: the hook is skippable with `--no-verify` and absent on a fresh clone, so a bypassed commit is only visible once it has landed. Merge subjects are git's rather than an author's and are not judged.

`dim install-hooks --write` appends a `SessionStart`/`SessionEnd` hook to `~/.claude/settings.json` and `~/.codex/hooks.json`, keeping every hook already there and copying each file to `<file>.dim-backup` first. The hook is one redirect into a spool directory and always exits 0. It is worth running early: a transcript records no end marker, so until the hooks are in, a session that was abandoned cannot be told from one still open, and that gap cannot be filled in later.

## Publishing

The collector, the CLI, the queries and the skills under `skills/` are general: nothing in `src/` names a person or a machine, and paths print relative to whoever is reading. What is specific to this owner is the argument for building it ([`docs/factory.md`](docs/factory.md)), the measurements taken from one corpus ([`docs/findings.md`](docs/findings.md)), and the ten evidence citations in `docs/design.md` that point at files under one home directory. A split separates those, and it stays a `git mv` for as long as nothing personal lands in a general file.

Two portability gaps stand in the way of anyone else running it: `install-agent` writes a launchd plist, which is macOS only, and the collector reads two tools' formats.

## Layout

| Path | Holds |
|---|---|
| [`docs/design.md`](docs/design.md) | Schema, the questions it answers, ingestion, the read path, build order |
| [`docs/findings.md`](docs/findings.md) | What the corpus said when it was first asked, and what each number can carry |
| [`docs/evals-and-hooks.md`](docs/evals-and-hooks.md) | The hook install layout, and the eval instrument that measures whether a skill's rules earn their place |
| [`docs/goals.md`](docs/goals.md) | What the repo is for, in order: fewer corrections first, fewer tokens for the same work second |
| [`docs/conventions.md`](docs/conventions.md) | Design: generating the machine-held half of the conventions, so a rule leaves only when a gate holds it |
| [`docs/recall.md`](docs/recall.md) | Reaching a session without being asked: the session-start channel, the chain a handoff makes, and why not a memory store |
| [`docs/worktrees.md`](docs/worktrees.md) | Adopting `wt`, and undoing an agent's writes without touching the user's repo |
| [`docs/loop.md`](docs/loop.md) | How a line gets cut and stays cut: what the corpus decides, what the evals decide, what is measured after |
| [`docs/factory.md`](docs/factory.md) | The argument this repo exists to execute |
| [`docs/landscape.md`](docs/landscape.md) | What else exists, which part of this it reaches, and what to borrow from it |
| [`docs/build-order.md`](docs/build-order.md) | What is not built, and what each piece waits on |
| `src/parse-claude.ts`, `src/parse-codex.ts` | One source line to rows; neither knows the database exists |
| `src/ingest.ts` | Every upsert and the byte cursor; knows neither format |
| `src/cli.ts` | `dim` |

## Constraints

- Nothing reaches the network, holds a credential, or is billed per token. `dim embed` and `q search` run a model, on weights that sit on disk after one download; every other path is parsing and SQL.
- No model reads a transcript. A model reads query results when asked a question, and `dim embed` reads only text a person already distilled.
- The database stores structure and a locator into the source file. Tool results, file contents and thinking stay out of it.
- Ingestion is incremental and idempotent — re-running never double-counts, and an in-progress session ingests cleanly and updates later.
- Codex has equal standing with Claude Code, not a later phase.

## Related

- `cniska/skills` — the stations this measures. It consumes the query CLI the way `pr` consumes `gh`; nothing here is installed by `npx skills add`.
