# Todo

What is not built, highest priority first. An entry is here only for a need this repo has now, and it is fixed at its cause, sized to the problem.

## Bugs

- **A test added after its fix is proved against the fix** — a proof lays the named tests over the head the turn started from, so a follow-up turn that adds only a test for an earlier commit's fix is proved on a base that already holds the fix, and runs green whether or not the test catches the defect (`skill-load-once`, 2026-09-29: `b553745` proved on `88f16f9`). `station-build-proof.ts` `proveTests`. Prove a follow-up turn's tests against the order's fork point.
- **`format-edit.test.ts` fails inside a worker** — two tests call `formatAfterEdit` with the process environment, so under a worker's `DIM_WORKER_NAME` it formats nothing and `bun run verify` goes red in a build turn. `format-edit.test.ts`. Pass the tests an empty environment.
- **A plugin skill loads under two names** — a `Skill` call names it `dim:dim-plan`, while a typed `/dim:dim-plan`, which `COMMAND_NAME` rejects for its colon, takes `dim-plan` from its body path, so `q skills` splits one skill across two rows. `ingest-skill-load.ts` `COMMAND_NAME`, `ingest-parse-claude.ts`. Read the plugin name from the typed command.
- **`q fixes` and `q stale` miss worktree edits** — they compare paths without folding worktrees, as `exemplars` does, so every factory build is missed. `query-code.ts`. Apply `withoutWorktree` to both sides.
- **Hook payloads are stored verbatim** — every PostToolUse stdin, with file contents, command output and edits, goes into `hook_event.payload`, which nothing reads, against [`design.md`](design.md) "Never stored". `ingest-spool.ts` `drainSpool`, `db-schema.ts` `hook_event`, `ingest-sync.ts`. Keep the parsed fields; drop the column.
- **A returned plan strands a pending rebase conflict** — `return --to plan` is admitted while a conflict is pending, and a reopened rebase whose conflict did not recur throws without clearing it, so every build fails. `order-state.ts`, `order-commits.ts` `pendingRebaseConflict`, `station-build-rebase.ts` `reopenRebase`, `order-approval.ts` `returnApprovedPlan`. Refuse the return while a conflict is pending.
- **A refused finding cannot be raised again** — the next round's diff covers only new commits, so a finding on an untouched file fails `assertLocations` and the whole report is discarded. `station-review.ts` `assertLocations` `reviewRange`. Review reads the whole order.
- **Workers and the check read the owner's home** — no sandbox denies reads under the home directory, so a worker or the check can read `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.grok` and `~/.ssh`; a Claude worker also holds `CLAUDE_CODE_OAUTH_TOKEN` when the owner sets it, and every worker gets the proxy URL. `harness-claude.ts`, `harness-codex.ts`, `harness-grok.ts`, `check-sandbox.ts`. Read-deny rules per sandbox.
- **Every Claude worker can write `dim`'s data directory**, not only the builder: planners and reviewers also get `--add-dir dataDir` and a sandbox that denies only their cwd, so any worker can write `sessions.db` or forge spool files, such as a SessionStart for a session it then registers as operator from a detached process. `harness-claude.ts` `claudeFlags`, `harness-codex.ts`.

## Debt

Each entry is one change. [schema] entries change the schema and run with nothing else in flight.

- **One git runner, one clock** — 12 `git()` wrappers with seven result shapes, raw git spawns in about 21 files and 6 `now()` copies handle failure differently at every call site. `git()` in `comments-files.ts` `git-committed.ts` `station-review.ts` `station-build-rebase.ts` `git-remote.ts` `git-trunk.ts` `guidance.ts` `ship.ts` `worktree.ts` `ship-cleanup.ts` `ship-rebase.ts` `station-build-tree.ts`; `now` in `worker.ts` `factory-stop.ts` `worker-assignment.ts` `order-ledger.ts` `order-finding.ts` `factory-schedule.ts`; one remote-URL parser for `git-remote.ts` `repositoryLabel` and `git-remote-slug.ts` `remoteSlug`.
- **One claim-and-fail path for station runners** — plan, build and review copy their claim, attempt and failure code and have drifted: review writes no `failed` event after a claim and has no up-front `assertNoRunningAttempt`, writes a Review artifact for a round with findings, and the operator parameter has three names. `station-plan.ts`, `station-build.ts` `runOrderBuildLive` `builderBrief` (ten positional arguments), `station-review.ts`, `station-attempt.ts`, `order-command.ts` `runOrderCommandLive` (`assertOperator` three times).
- **Orchestration out of `order-command.ts`** — approve-then-ship as two transactions and the remaining-slices loop live in the command. `runOrderCommand`, `runRemainingBuilds`. Also one function for the sandboxed check (`station-build-commit.ts`, `order-ship.ts` `recheck`).
- **One descriptor per harness** — adding a harness touches about ten files, and `hookConfigPath` and `wantedHooks` treat any unknown harness as Codex. `harness-name.ts`, `ingest-tools.ts`, `hooks.ts`, `ingest-sources.ts`, `ingest-history.ts`, `station-environment.ts`, `guidance-walk.ts`, `session-start-context.ts`.
- **Closed vocabularies are exhaustive at compile time** [schema] — one `as const` list per vocabulary feeds both its type and its `CHECK`: `dimension` (both finding tables), `session.tool`, attempt `harness` and `tier` have none, and priority, role, artifact kind, severity, answer and the outcome lists are hand copies. `Tool` and `HarnessName` become one list; `running` stops being an attempt outcome; `finding.ts` `Answer` and `FindingAnswer` become one; `order-ship-run.ts` `code` takes the refusal codes.
- **Order table cleanup** [schema] — stale columns dropped; an attempt is a row and a `station_started` event with `session_id` always equal to `provider_session_id`; `updated_at` disagrees with the ledger, so `q factory` and the wall sort differently; the order defaults live in the command, `queueOrder` and the schema; `correction_label.skill_name` is never written.
- **Order worker assignment cleanup** [schema] — the order's worker identity and provider session live in its assignment rather than in a second binding row read through `coalesce` (`station-worker.ts` `readOrderWorker`), with no `DEFAULT 'codex'` guessing a harness; `OrderStationName` and `STATION_ROLES` give way to `Station`.
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
- Sunset handoffs once the factory is live? An order and its resumed worker replace the next move a handoff carries.
- Repo identity is `project`, `repo` and `label`, sometimes a path and sometimes owner/repo, and `finding.repo`'s comment prescribes a join that returns nothing. "Finding" names review findings, checking-agent findings and measurements; "trunk" and "default branch" name one thing; an attempt's `run_id` shadows the ship run; the glossary lacks repo, checkout, round, assignment, brief, runner and runner barrier. Which words?
- Are `finding` and `factory_order_finding` one concept? `q findings` reads only the first.

## Waiting on data

- Whether any unmarked or v1 spool hook is still installed, so `hooks.ts` `hookKind` can drop the retired shapes it recognises only to replace them.
- Whether Codex records a typed prompt as an event, so `ingest-parse-codex.ts` can drop its prompt-source regex; and the real usage-limit window, so `q burn` can drop its epoch-aligned five-hour blocks.
