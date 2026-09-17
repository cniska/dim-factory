# dim-factory

A software factory run by coding agents, with a human at the gates that still earn one.

The stations are the `dim-` skills under [`skills/`](skills), each with an entry contract and an exit check, and the floor that runs them is a coding agent. What separates a station from a generic engineering skill is that it reads the record: prior art on the disks here, the files a later fix commit came back to, whether an earlier conclusion still holds. None of them is portable to a machine without this database, which is why they ship here. Around them is the rest of it: the record of what every session did, the questions asked of that record, and the gates that hold a rule whether or not a skill loaded.

[`docs/factory.md`](docs/factory.md) is the argument. The question is not whether the line can run itself but at which gates removing the human costs more than it saves, and the answer is a dim factory rather than a dark one: autonomous between the gates, a human at the gates that matter, and each gate earning its automation on its own merit.

Merit means evidence, so the factory measures itself. [`docs/goals.md`](docs/goals.md) states what it is measured against.

The factory is also what builds the factory. Every station here is run on this repo: a feature arrives through `dim-feat`, a defect through `dim-fix`, each slice is checked by an agent before it is committed, and each commit passes the same hooks every other repo on this machine gets.

That is not a flourish — it is the only arm the design can run on itself, and it has already paid twice:

- The push gate shipped with a hole that let through the one force push it existed to refuse, caught by the checking agent the build station mandates.
- The gate was then found unarmed in this repo, because a ref only `git clone` writes was missing here.

Both are in [`docs/findings.md`](docs/findings.md), because a factory that cannot find its own defects has no standing to claim it finds anyone else's.

## What it does

- **Collects.** Claude Code and Codex both record every session to disk. An incremental ingester reads both into one SQLite database — deterministic parsing and inserts, no model calls anywhere in the collection path.
- **Answers.** A small query CLI over that database: where loaded-skill context goes, which skills fire and by which path, where corrections cluster, what tokens and tools a session actually spends.
- **Guards.** Hooks that make mechanical what a skill can only instruct.
- **Installs.** One copy of the tooling every checkout needs — the commit-subject gate, the flattened rules, the sync agent — linked or pointed at from each repo rather than copied into it, so what runs cannot drift from what is tested here. A script that a third checkout would have to port belongs here instead; the same file under two repos has already diverged every time ([`docs/findings.md`](docs/findings.md)).

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
bun run dim install-commit-gate --owner=<host>/<account>  # subject, check and push gates for every repo; --write installs
bun run dim wt <branch>     # create or reuse this task's worktree and print its path
bun run dim wake            # the last session's Next and what the repo declares, for SessionStart
bun run dim q chain [id]    # which sessions were one piece of work, joined by the handoff between them
bun run dim q prior-art "<path>"   # how the same problem was solved in the repos already on disk
bun run dim q convention [repo]    # the commit convention each repo's own log holds
bun run dim check-commits <range>  # judge a revision range by the same rules the gate holds
bun run dim sql "<select>"  # one read-only statement, for a question no named query covers
bun run dim q list          # the named questions; `q <name>` asks one, --json for the raw rows
bun run verify              # lint, typecheck, test
```

`bun link` puts `dim` on PATH, which is what makes it usable from another repo — and an agent can only reach it from the repo it is working in.

### Asking it something

`dim sql "<select>"` runs one statement against the same read-only connection the queries use, so a question no named query covers does not mean leaving the tool. A statement that writes is refused by SQLite rather than by a rule here, which would have to be right about every spelling of a write. The named questions are grown from this: a question worth asking twice becomes one of them.

Every query prints the base its numbers came from, and a query with nothing to report says so rather than printing a zero. Queries cover the last 30 days unless given `--since <n>d|YYYY-MM-DD` or `--all`; the window is printed with the numbers. A result longer than 40 rows says how many were cut and names `--rows <n>`, which widens it. Cells are separated, not padded out to the column width: an agent reads this far more often than a person does, and alignment costs it a run of spaces on every row. Readers open the database read-only.

### The database

The database lands in `~/.local/share/dim-factory/sessions.db`. Reading the whole corpus from scratch takes about 20 seconds.

Each `dim q` writes one `command_trace` row: the query, which branch answered, how many rows and how long. Which commands an agent ran is already in `tool_call`, since every one is a shell call in a transcript — what is not anywhere else is which branch served it, because `q search` falling back from cosine to the keyword index looks identical in the rows, and a query run from a terminal belongs to no session. The row is written on a second connection after the output is rendered, and a failure to write it is dropped rather than failing the query.

A subagent is identified by its agent id and its parent together, written `<agent>@<parent>`, because Claude Code reuses an agent id across parent sessions. The agent id leads, so a prefix search still finds it. Keyed on the agent id alone, two different runs become one session row and the second file is read from the first's cursor.

`sync` reads past a complete line that is not JSON rather than refusing the file, which is what stops one corrupt record from stalling collection. The cursor advances over it, so that sync is the only one that can ever name it: it prints the file and the line number to stderr, and the launchd agent's `sync.log` is where that lands. `dim rebuild` reads the file from the start and reports it again.

Claude Code deletes transcripts after 30 days unless told otherwise, so `~/.claude/settings.json` sets `"cleanupPeriodDays": 3650`. Without it the sources this points into disappear.

### Checking the install

`dim doctor` checks the paths that fail silently: retention unset, hooks installed but never firing, a Codex hook installed but not trusted, a launchd agent written but never loaded, a spool nothing drains, a commit gate covering no repo, a gate whose owners name no host, a checkout where the push gate can never fire, a database built by an older schema. It reads only, exits non-zero when a check fails, and every failure names its fix.

Codex runs a hook only where `~/.codex/config.toml` records a `trusted_hash` for it under `[hooks.state]`, keyed `<hooks.json path>:<event>:<entry index>:<hook index>`. Trust is positional, so another tool inserting an entry ahead of dim's moves dim's hook to a key approved for a different command, and collection and `wake` stop on the Codex side with `hooks.json` still reading as correct. The check reads whether a trust is recorded at each hook's current position; the hash itself is Codex's to verify, so a missing key proves the hook will not run and a present one says only that the position was approved.

### Wiring the session hooks

`dim install-hooks --write` appends a `SessionStart`/`SessionEnd` hook to `~/.claude/settings.json` and `~/.codex/hooks.json`, keeping every hook already there and copying each file to `<file>.dim-backup` first. It edits the file in place rather than rewriting it, so a config carrying comments installs and keeps them, along with its own indent and key order. The lines the insertion touches are re-laid-out and the rest of the file is left alone. Where the key being written into appears twice, the write is refused: an editor reaches the first copy and a reader takes the last, so the hook would land where nothing looks. The hook is one redirect into a spool directory and always exits 0. It is worth running early: a transcript records no end marker, so until the hooks are in, a session that was abandoned cannot be told from one still open, and that gap cannot be filled in later.

### Installing the rest

`dim install-agent --write` writes a launchd agent that runs `dim sync` every 15 minutes, logging to `~/.local/share/dim-factory/sync.log`; load it with the `launchctl bootstrap` line the command prints. Re-run it after a toolchain change, since the plist names an absolute `bun`.

`dim install-rules --write` writes `~/.codex/AGENTS.md` from `~/.claude/CLAUDE.md` with every `@import` expanded. Claude Code expands those imports and Codex does not — a sentinel placed behind one reached Claude and never reached Codex — so a rules file that imports delivers its import line to Codex as literal text. A relative import resolves against the target tool's own directory, so `@RTK.md` picks up the Codex copy rather than the Claude one. `dim doctor` fails when the two drift.

`dim install-skill --write` links every station under `skills/` into `~/.agents/skills` and `~/.codex/skills`. Claude and Acolyte both read the first by convention; Codex reads its own.

Two stations are front doors and the rest are invoked:

- **`dim-feat`** — scopes new work against prior art and cuts it into slices. It invokes `dim-plan` where the cut is not obvious, which gathers what the record holds and hands the planning to a more capable model.
- **`dim-fix`** — triages a defect and proves it with a failing test.
- **`dim-build`** — the slice loop both front doors hand to: the repo's own check, a checking agent on each diff, then the commit.
- **`dim-review`** — stands on its own, running one agent per dimension against work you did not write. It is the one station the record shows used far more often without a build than with one.

Adding a station is a directory under `skills/` and a name in `SKILL_NAMES`; a station retired from that list has its link removed on the next install, so a name never resolves to nothing.

The database holds every tool's sessions, so this is also how one tool reads what another did: a Claude session can recover a decision made in Codex, and the reverse. They share a record rather than a channel — neither has to be running for the other to read it.

### The gates

`dim install-commit-gate --owner=<host>/<account> --write` writes a `commit-msg`, a `pre-commit` and a `pre-push` hook to `~/.config/dim/hooks/` and points git's global `core.hooksPath` at it, so every repo shares a single copy and a rule fixed once is fixed everywhere.

- **`commit-msg`** — holds the subject convention: Conventional Commits, a single line of at most 50 characters, ASCII, no body.
- **`pre-commit`** — asks `dim check-task` what the repo declares as its check, runs it, and refuses the commit when it fails. `DIM_SKIP_CHECK=1 git commit` skips this hook alone, because `--no-verify` is git's only escape and it would take the subject gate with it.
- **`pre-push`** — refuses a push that drops the remote's tip out of the history of the branch the remote's own HEAD names, which is the shape of a rewrite whatever flag produced it. It also refuses a delete of that branch, and a push over a tip the checkout has never fetched, because that is the push that loses work rather than the one that cannot be judged. A topic branch is left alone, a remote naming no HEAD leaves nothing to protect, and `--no-verify` is the way past this one, taking no other gate with it. Git names the remote by its name or by its URL depending on how the push was spelled, so the hook reduces both the pushed URL and each configured remote's effective push URL to one spelling and matches them; a URL resolving to no configured remote is one this checkout tracks nothing on, and it passes.

Ownership decides whether any of them apply, and it is checked when the hook runs rather than when it is installed — so a clone of someone else's project keeps its own conventions, and a repo cloned later is covered without reinstalling. An owner is a host and an account together: an account name alone is something anyone can register on another forge or name a directory after, and `pre-commit` runs what the repository's own manifest declares. The owner is read from the remote being pushed to, so a fork's upstream is judged by the account it lands in.

> What the host match cannot guard is a branch inside a repository that is genuinely the owner's. Checking out a fork's pull request puts a contributor's manifest in the tree, and the next commit runs it.

A repo that sets its own `core.hooksPath` keeps the hooks it has, because git resolves that setting locally before globally. Where the global setting is already pointed somewhere else — a managed install does this — the command refuses and names it before writing anything, since git reads one hooks directory and merges nothing.

All three are self-contained bash that exits 0 on anything they cannot establish, because they run before every commit and every push on the machine.

### Worktrees

`dim wt <branch>` makes one worktree per task at `<repo>/.claude/worktrees/<branch>`, runs the repo's `scripts/worktree-setup.sh` on creation and `scripts/worktree-teardown.sh` before removal, and keeps the branch so the work can still be merged. `dim wt` on its own prints the rest: `ls`, `path`, `rm [--force]` and `prune`.

It is a dim command rather than a script on PATH because this is the repo that already reads its convention ([`src/worktree.ts`](src/worktree.ts)), and one binary is one thing to install and one thing the tests cover. Nothing here changes the caller's directory, which is what `dim wt path` is for. See [`docs/worktrees.md`](docs/worktrees.md).

### Reaching a session at start-up

`dim wake` prints the Next left by the last session that worked in this directory, and `install-hooks` wires it to `SessionStart` on both tools. That is the only channel here reaching a session without anyone deciding to ask: Claude Code adds a SessionStart hook's plain-text stdout to the session as context the model can act on, and Codex takes the same block as `hookSpecificOutput.additionalContext`, which is why `--tool=` picks the envelope.

It carries a handoff's `## Next` and, beside it, the check and format commands the repo declares, read by `src/tasks.ts` from `package.json`, `mise.toml` or a `Makefile`. Nothing else a query can answer goes in, because the block costs tokens in every session that starts here, and the test for a line is that a cold start cannot reach it for less — the declared commands are reachable, but only by opening a manifest, which costs a tool call and its output. A repo that declares neither gets neither, and where there is also no Next the block is empty.

The text comes from the transcript rather than the file, since a handoff is printed before it is pasted. A message counts as one when it carries the heading and a Next that parses: a quarter of the handoffs in the corpus were written under no skill, so the `handoff` attribution cannot be the test.

The same hook records the guidance walk: which rules files were in force together for that session, and which one imported another.

It resolves `~/.claude/CLAUDE.md` (or `~/.codex/AGENTS.md`), the `CLAUDE.md` and `AGENTS.md` from the working directory up to the repo root, and every file a line of the form `@<path>` pulls in, writing a sha per surface to the spool for `sync` to drain into `guidance_walk`. It goes through the spool because a hook that waits on the write lock delays every session that starts here.

`guidance_version` says what each file held; this says they were read as one set, which is what makes the same project file mean different things under different conventions. It is recorded at session start, so a rules file edited mid-session is missed.

The wake hook is the one hook here that speaks rather than records, so it is the one that can waste tokens: it runs before every session, and what it prints is paid for in every session that starts. `dim q skill handoff` measures whether it pays.

### The named questions

`dim q chain [id-prefix]` answers which sessions were one piece of work. A handoff is printed into one transcript and pasted into the next, so `sync` joins the two on the heading line and writes an edge per paste into `handoff_link`; where a title was reused, the writer is the nearest preceding printer in another session.

Without an argument it groups the edges by title, ranking the tasks that spanned the most sessions. With one it walks the edge in both directions from that session, so it crosses a task that was renamed midway and branches where one handoff was pasted into two sessions.

Around one paste in five finds no writer, because that transcript was pruned before it was ever read. The table is derived and replaced whole on every sync, so a link exists only while both messages do.

`dim q prior-art "<path fragment>"` answers how the same problem was solved before: every tracked file whose path matches, across the repos the corpus names, dated by the commits that touched it. It reads `repo_file`, which `sync` replaces whole from `git ls-files` on every run, so every path it prints opens — `commit_file` records what a repo once held, where a rename is a delete and an add and a file deleted years ago still has its rows. Worktrees fold onto the file they are a copy of, and at most three files come from any one repo, so a repo with fifty workflows cannot be the whole answer. It ranks by recency and commit count, which is not quality.

`dim q convention [repo-fragment]` says what a repo's own log holds as its commit rule: the share of subjects that are Conventional Commits, their mean length, the share over fifty characters, and the share carrying the `(#N)` suffix a forge appends on a squash merge, which is how much of the history arrived through a branch.

The tool-agnostic advice for this is to skim `git log` and match it; the whole log is already a table here, so a station reads a row. A repo that was cloned rather than written reports its authors' convention, so the repo column is read first.

`dim check-commits <range>` judges every authored subject in a revision range by `checkSubject`, the same function the installed hook's rules mirror, and names each commit and the rule it broke. CI runs it over what each push added: the hook is skippable with `--no-verify` and absent on a fresh clone, so a bypassed commit is only visible once it has landed. Merge subjects are git's rather than an author's and are not judged.

## Publishing

The collector, the CLI, the queries and the skills under `skills/` are general: nothing in `src/` names a person or a machine, and paths print relative to whoever is reading. What is specific to this owner is the argument for building it ([`docs/factory.md`](docs/factory.md)), the measurements taken from one corpus ([`docs/findings.md`](docs/findings.md)), and the ten evidence citations in `docs/design.md` that point at files under one home directory. A split separates those, and it stays a `git mv` for as long as nothing personal lands in a general file.

Two portability gaps stand in the way of anyone else running it: `install-agent` writes a launchd plist, which is macOS only, and the collector reads two tools' formats.

## Layout

The reasoning lives under [`docs/`](docs/README.md), which indexes itself. What is here is the code:

| Path | Holds |
|---|---|
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

- `cniska/skills` — the tool-agnostic engineering skills, which run on a machine with no database and are measured here like any other work. A station is the case that needs `dim` on PATH; nothing here is installed by `npx skills add`.
