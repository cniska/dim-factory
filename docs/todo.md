# Todo

What is not built, highest priority first. An entry is here only for a need this repo has now, and it is fixed at its cause, sized to the problem.

## Bugs

- **`format-edit.test.ts` fails inside a worker** — two tests call `formatAfterEdit` with the process environment, so under a worker's `DIM_WORKER_NAME` it formats nothing and `bun run verify` goes red in a build turn. `format-edit.test.ts`. Pass the tests an empty environment.
- **A plugin skill loads under two names** — a `Skill` call names it `dim:dim-plan`, while a typed `/dim:dim-plan`, which `COMMAND_NAME` rejects for its colon, takes `dim-plan` from its body path, so `skill_load` records one skill under two names. `ingest-skill-load.ts` `COMMAND_NAME`, `ingest-parse-claude.ts`. Read the plugin name from the typed command.
- **Hook payloads are stored verbatim** — every PostToolUse stdin, with file contents, command output and edits, goes into `hook_event.payload`, which nothing reads, against [`design.md`](design.md) "Never stored". `ingest-spool.ts` `drainSpool`, `db-schema.ts` `hook_event`, `ingest-sync.ts`. Keep the parsed fields; drop the column.
- **A reopened rebase strands its conflict** — a reopened rebase whose conflict did not recur throws without clearing it, so every build fails. `order-commits.ts` `pendingRebaseConflict`, `station-build-rebase.ts` `reopenRebase`. Clear the conflict when the reopened rebase applies cleanly.
- **Workers and the check read the owner's home** — no sandbox denies reads under the home directory, so a worker or the check can read `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.grok` and `~/.ssh`; a Claude worker also holds `CLAUDE_CODE_OAUTH_TOKEN` when the owner sets it, and every worker gets the proxy URL. `harness-claude.ts`, `harness-codex.ts`, `harness-grok.ts`, `check-sandbox.ts`. Read-deny rules per sandbox.
- **Every Claude worker can write `dim`'s data directory**, not only the builder: planners and reviewers also get `--add-dir dataDir` and a sandbox that denies only their cwd, so any worker can write `sessions.db` or forge spool files, such as a SessionStart for a session it then registers as operator from a detached process. `harness-claude.ts` `claudeFlags`, `harness-codex.ts`.

## Debt

Each entry is one change. [schema] entries change the schema and run with nothing else in flight.

- **One git runner, one clock** — 12 `git()` wrappers with seven result shapes, raw git spawns in about 21 files and 6 `now()` copies handle failure differently at every call site. `git()` in `comments-files.ts` `git-committed.ts` `station-review.ts` `station-build-rebase.ts` `git-remote.ts` `git-trunk.ts` `guidance.ts` `ship.ts` `worktree.ts` `ship-cleanup.ts` `git-rebase.ts` `station-build-tree.ts`; `now` in `worker.ts` `worker-assignment.ts` `order-ledger.ts` `order-finding.ts`; one remote-URL parser for `git-remote.ts` `repositoryLabel` and `git-remote-slug.ts` `remoteSlug`.
- **Station leftovers** — review writes a Review artifact for a round with findings, though `factory.md` says only a round that raises nothing writes one; the operator role is checked three times on a delegation (`order-command.ts` `runOrderCommandLive`, `admitAct`, `startAttempt`).
- **Orchestration out of `order-command.ts`** — approve-then-ship as two transactions and the remaining-slices loop live in the command. `runOrderCommand`, `runRemainingBuilds`. Also one function for the sandboxed check (`station-build-commit.ts`, `ship.ts` `recheck`).
- **One descriptor per harness** — adding a harness touches about ten files, and `hookConfigPath` and `wantedHooks` treat any unknown harness as Codex. `harness-name.ts`, `ingest-tools.ts`, `hooks.ts`, `ingest-sources.ts`, `ingest-history.ts`, `station-environment.ts`, `guidance-walk.ts`, `session-start-context.ts`.
- **Closed vocabularies are exhaustive at compile time** [schema] — one `as const` list per vocabulary feeds both its type and its `CHECK`: `dimension` (`factory_order_finding`), `session.tool`, attempt `harness` and `tier` have none, and role, artifact kind, severity, answer and the outcome lists are hand copies. `Tool` and `HarnessName` become one list; `running` stops being an attempt outcome; `finding.ts` `Answer` and `FindingAnswer` become one.
- **Order table cleanup** [schema] — stale columns dropped; an attempt is a row and a `station_started` event with `session_id` always equal to `provider_session_id`; `updated_at` disagrees with the ledger, so `q factory` and the wall sort differently; the order defaults live in the command, `queueOrder` and the schema.
- **The FTS trigger re-indexes unchanged text** [schema] — `message_fts_update` re-indexes a message whose text did not change, about five times the ingest cost, and `message.src_file` and `tool_call.src_file` cascade with no index. `db-schema.ts`. `WHEN old.text IS NOT new.text` on the trigger, and the two indexes.
- **Comments in the schema and generated files** — `db-schema.ts` carries 56 SQL comment blocks, some stale, and `wall/styles.css` and the generated hooks carry rationale comments, against the ban. A table's reason goes into [`design.md`](design.md), and design.md stops saying it lives beside the table.
- **Tests without proof or duplicates** — the trace permission tests prove nothing as root; the lock tests in `ingest-launchd.test.ts` repeat `db-lock.test.ts`; spies in `db.test.ts` and `rebuild.test.ts` test calls, not outcomes; `ingest-tools.test.ts` and `order-events.test.ts` assert schema text; duplicate cases in `factory-stop.test.ts` and `order-state.test.ts`; six ship tests in `order.test.ts` repeat their setup; three harness doubles cover one interface; `src/wall/client.test.tsx` greps its own source for class strings, so it fails on a restyle and passes on a broken render.

## Features

- **The factory picks its own work** — select ready orders and run a bounded count, with claims and integration serialized, so fix orders run unattended.
- **Ship through a pull request** — `dim.ship = pull-request`, since most repos do not fast-forward their default branch. Built against one of the owner's repos that ships by PR, once the factory runs again.
- **Gates earn trust per kind of order** — over a lookback window with a minimum sample, the record shows which kinds of order the owner has stopped needing to read, and the wall marks them. Trust is asymmetric: a return or a revert demotes at once, and promotion happens only on the owner's word, citing the evidence ([`landscape.md`](landscape.md#earned-autonomy)).

## Owner decides

- Rename the `dim.ship = trunk` setting to `merge`.
- Should the comment gate refuse `biome-ignore` and `@ts-*`?
- Does an unattended run push, or commit locally?
- Does the wall become where the owner reads artifacts and approves, rather than only watches?
- Is `dim` for one owner, or for teams with several?
- Repo identity is `project`, `repo` and `label`, sometimes a path and sometimes owner/repo, and `finding.repo`'s comment prescribes a join that returns nothing. "Finding" names review findings, checking-agent findings and measurements; "trunk" and "default branch" name one thing; an attempt's `run_id` shadows the ship run; the glossary lacks repo, checkout, round, assignment, brief, runner and runner barrier. Which words?

## Waiting on data

- Whether any unmarked or v1 spool hook is still installed, so `hooks.ts` `hookKind` can drop the retired shapes it recognises only to replace them.
- Whether Codex records a typed prompt as an event, so `ingest-parse-codex.ts` can drop its prompt-source regex.
