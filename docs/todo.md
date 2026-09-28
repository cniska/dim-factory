# Todo

What is not built, highest priority first. `dim order ready` lists what is queued. An item stays here only while it needs work of its own; anything fixable where it was found is fixed there.

## Bugs

- **Workers and the check read the owner's home** — no sandbox denies reads under the home directory, so a worker or the check can read `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.grok` and `~/.ssh`; a Claude worker also holds `CLAUDE_CODE_OAUTH_TOKEN` when the owner sets it, and every worker gets the proxy URL. `harness-claude.ts`, `harness-codex.ts`, `harness-grok.ts`, `check-sandbox.ts`. Read-deny rules per sandbox.
- **A builder redefines the check indirectly** — the runner refuses a changed check task, but not what the task reaches: scripts it calls by name (`bun run lint` inside `verify`), a `GNUmakefile` or `makefile` shadowing `Makefile`, a `mise.local.toml` or mise task directory, and Makefile variables and includes. `workspace-tasks.ts` `trunkCheck`. Run the check against the trunk's manifests, or refuse a turn that changes them.
- **Every Claude worker can write `dim`'s data directory**, not only the builder: planners and reviewers also get `--add-dir dataDir` and a sandbox that denies only their cwd, so any worker can write `sessions.db` or forge spool files, such as a SessionStart for a session it then registers as operator from a detached process. `harness-claude.ts` `claudeFlags`, `harness-codex.ts`.
- **Hook payloads are stored verbatim** — every PostToolUse stdin, with file contents, command output and edits, goes into `hook_event.payload`, which nothing reads, against [`design.md`](design.md) "Never stored". `ingest-spool.ts` `drainSpool`, `db-schema.ts` `hook_event`, `ingest-sync.ts`. Keep the parsed fields; drop the column.
- **A shrunk transcript with a child session loses messages and fails every sync** — `resetSession` deletes outside the chunk's transaction, then `DELETE FROM session` fails the `parent_id` key. `ingest.ts` `resetSession`, `ingestFile`. Reset inside the transaction and keep the parent row.
- **`dim rebuild` cannot absorb a new indexed column** — `openDb` runs `SCHEMA_SQL` on the old tables before rebuild drops them, so an index on the new column throws. `db.ts` `openDb` (`forRebuild`), `ingest-sync.ts` `rebuild`. Skip the schema under `forRebuild` until the drop.
- **A database from before schema 80 cannot rebuild** — the dropped `token_digest` column holds a value in every existing `factory_worker` and `factory_worker_assignment` row, so `assertCarriedColumnsFit` refuses, and the column is `UNIQUE`, so `sqlite3 DROP COLUMN` fails too. `ingest-sync.ts` `assertCarriedColumnsFit`. Let a schema change name the columns it discards; prove it on a v79 database with [`dim-verify`](../.agents/skills/dim-verify/SKILL.md).
- **An interrupted rebased ship can never be recorded** — `shipOrder` fast-forwards the trunk, tears the worktree down, and only then records the landing and rewrite, so a crash, a busy database or a hung teardown hook leaves the commits on the trunk and every retry refused. `order-ship.ts` `shipOrder`. Record the landing right after `shipBranch`.
- **Ship lands half an order** — the tip check accepts a branch at any recorded commit, so the trunk is fast-forwarded to an earlier one before `ship_not_landed` refuses. `ship.ts` `shipBranch`. Require the order's last commit or its rewrite.
- **A returned plan strands a pending rebase conflict** — `return --to plan` is admitted while a conflict is pending, and a reopened rebase whose conflict did not recur throws without clearing it, so every build fails. `order-state.ts`, `order-commits.ts` `pendingRebaseConflict`, `station-build-rebase.ts` `reopenRebase`, `order-approval.ts` `returnApprovedPlan`. Refuse the return while a conflict is pending, or record the resolution.
- **Starting an order holds the write lock through setup** — `git worktree add` and the setup hook run inside `writeTransaction`, so other writers fail after five seconds, and a rollback leaves a worktree for a queued order whose retry reuses it without a setup report. `order-lifecycle.ts` `startOrder`. Create the worktree first, then record in a short transaction.
- **A usage-limited review never moves to another harness** — `runOrderReviewLive` returns `aborted` where plan and build throw, so `onHarnessWithCapacity` never tries the next. `station-review.ts`, `station-harness.ts`. Throw on a limited turn.
- **A refused finding cannot be raised again** — the next round's diff covers only new commits, so a finding on an untouched file fails `assertLocations` and the whole report is discarded. `station-review.ts` `assertLocations` `reviewRange`. Admit files of standing findings.
- **Fallback harnesses include uninstalled ones** — a fallback spawn fails with `ENOENT`, which is not a limit, so the delegation fails. `order-command.ts` `candidateHarnesses`. Filter by `harnessInstalled`.
- **A red check is briefed as a ship rebase** — a runner check that failed in a build turn is headed "Red check at the rebased head". `order-head-check.ts` `failedHeadCheck`, `station-build.ts` `builderBrief`. Keep where the check ran.
- **Spool files are read half-written** — `cat >` creates the file before writing it, so a sync that reads it early parks it in `spool/unreadable/` for good. `hooks.ts` `hookCommand`, `ingest-spool.ts` `drainSpool`. Write to a temporary name, then `mv`.
- **Hook events in one millisecond collapse** — the nanosecond stamp is cut to milliseconds under `UNIQUE (session_id, event, ts)`. `ingest-spool.ts`, `db-schema.ts` `hook_event`. Key on the spool name.
- **`install-commit-gate --write` deletes a repo's own `commit-msg`** without reading it. `gate-commit.ts` `planCommitGate`. Delete only a dim gate's body.
- **`commit-msg` refuses `git commit -v`** and any `core.commentChar` other than `#`, reading the scissors and diff as a body. `gate-commit.ts` `hookScript`. Stop at the scissors; read the comment char.
- **Incremental git ingest misses old commits fast-forwarded in** — `--since` filters by committer date from a window on author dates. `ingest-git.ts`, `ingest-git-source.ts` `readCommits`. A per-repo cursor of seen tips.
- **A Claude skill load counts twice** — the `Skill` call and its injected body are two rows, doubling `q skills` and `q skill`. `ingest-parse-claude.ts`, `query-skill.ts`. Attach the body to the call's row.
- **`q fixes` and `q stale` miss worktree edits** — they compare paths without folding worktrees, as `exemplars` does. `query-code.ts`. Apply `withoutWorktree` to both sides.
- **`q slices` reads `verify && git commit` as unchecked** — `is_check` needs an exact command match. `query-factory.ts` `slices`.
- **`dim q order` hides the request and the latest evidence** — its first row has no title, description or line, which `dim-factory` and `dim-add` read there, and its rows are oldest first under a 40-row cap. `query-factory.ts` `order`. Add the fields; show the newest first.
- **`scripts/reset-factory.ts` refuses every current database** — its hand list lacks `factory_runner_barrier` and still names four dropped tables. Derive it from `FACTORY_ORDER_TABLES`.
- **`@~/` guidance imports resolve from the importing file**, not home. `guidance-walk.ts`.
- **A moved data directory duplicates the SessionStart hook** — `hookKind` recognises a spool hook under an old data directory only without `-$PPID`, so after `DIM_HOME` moves the SessionStart hook reads as missing and `install-hooks` adds a second one. `hooks.ts` `hookKind`.
- **The wall's order view drops its error** — a failed order read shows "This order's record could not be read." without the server's message, which the feed now carries. `wall/client.tsx`.
- **`dim sql` can change the journal mode** — a reader opens read-write under `query_only`, which does not stop `PRAGMA journal_mode = DELETE`, so a query switches the record out of WAL. `db-read.ts` `openReadOnly`. Open readers `readonly`, once the case in [`design.md`](design.md) where that fails on a WAL database without its `-wal` and `-shm` files is settled on the owner's SQLite.
- **The scripted harness cannot build after a return** — a returned build's brief has no current slice, so `scripts/verify-harness.ts` answers as slice 1 with an empty Build artifact and `dim-verify` cannot ship a returned order.
- A moved checkout reads as a second repo.
- Editing a JSONC file moves a trailing array comment onto the new entry, and turns CRLF into LF.

## Debt

Each entry is one change. [schema] entries change the schema and run with nothing else in flight.

- **One git runner, one clock** — 13 private `git()` wrappers with five result shapes, raw git spawns in about 21 files and 6 `now()` copies handle failure differently at every call site. `git()` in `comments-files.ts` `station-build-commit.ts` `station-review.ts` `station-build-rebase.ts` `git-remote.ts` `git-trunk.ts` `guidance.ts` `ship.ts` `worktree.ts` `ship-cleanup.ts` `ship-rebase.ts` `station-build-tree.ts`; `now` in `worker.ts` `factory-stop.ts` `worker-assignment.ts` `order-ledger.ts` `order-finding.ts` `factory-schedule.ts`; one remote-URL parser for `git-remote.ts` `repositoryLabel` and `git-remote-slug.ts` `remoteSlug`.
- **One claim-and-fail path for station runners** — plan, build and review copy their claim, attempt and failure code and have drifted: review writes no `failed` event after a claim and has no up-front `assertNoRunningAttempt`, writes a Review artifact for a round with findings, and the operator parameter has three names. `station-plan.ts`, `station-build.ts` `runOrderBuildLive` `builderBrief` (ten positional arguments), `station-review.ts`, `station-attempt.ts`, `order-command.ts` `runOrderCommandLive` (`assertOperator` three times).
- **Orchestration out of `order-command.ts`** — approve-then-ship as two transactions, the remaining-slices loop and the harness candidate order live in the command. `runOrderCommand`, `runRemainingBuilds`, `candidateHarnesses`. Also record a ship refused by a held lock, and one function for the sandboxed check (`station-build-commit.ts`, `order-ship.ts` `recheck`).
- **One descriptor per harness** — adding a harness touches about ten files, and `hookConfigPath` and `wantedHooks` treat any unknown harness as Codex. `harness-name.ts`, `ingest-tools.ts`, `hooks.ts`, `ingest-sources.ts`, `ingest-history.ts`, `station-environment.ts`, `guidance-walk.ts`, `session-start-context.ts`.
- **Sync reads only what is new** — it rebuilds every handoff, re-reads `history.jsonl` from byte 0, reinserts `ls-files`, and runs full-history `git log --raw` twice per repo, all inside write transactions, and a worktree and its checkout reset each other's commit cursor. `recall-handoff.ts`, `ingest-history.ts`, `repo-files.ts`, `guidance.ts`, `ingest-git.ts`. Read git first, then write; cursors per source.
- **Index what the hot paths scan** [schema] — the wall's one-second poll and every order act scan `factory_order_event` by `artifact_id`; `message.src_file` and `tool_call.src_file` cascade with no index; and `message_fts_update` re-indexes a message whose text did not change, about five times the ingest cost. `db-schema.ts`. The three indexes, and `WHEN old.text IS NOT new.text` on the trigger.
- **Tests without proof or duplicates** — the trace permission tests prove nothing as root; the lock tests in `ingest-launchd.test.ts` repeat `db-lock.test.ts`; spies in `db.test.ts` and `rebuild.test.ts` test calls, not outcomes; `ingest-tools.test.ts` and `order-events.test.ts` assert schema text; duplicate cases in `factory-stop.test.ts` and `order-state.test.ts`; six ship tests in `order.test.ts` repeat their setup; three harness doubles cover one interface.

## Features

- **Refuse a secret at ship** — an order's diff carrying a key shape is not shipped.
- **Ship through a pull request** — `dim.ship = pull-request`, since most repos do not fast-forward their default branch. Built against one of the owner's repos that ships by PR, once the factory runs again.
- **Order table cleanup** [schema] — per-kind event references with foreign keys, stale columns dropped, and an event for amend. An attempt is a row and a `station_started` event with `session_id` always equal to `provider_session_id`; `updated_at` disagrees with the ledger, so `q factory` and the wall sort differently; the order defaults live in the command, `queueOrder` and the schema; `correction_label.skill_name` is never written; the `factory_order` comment sits above another table.
- **Order worker assignment cleanup** [schema] — the order's worker identity and provider session live in its assignment rather than in a second binding row read through `coalesce` (`station-worker.ts` `readOrderWorker`), with no `DEFAULT 'codex'` guessing a harness; `OrderStationName` and `STATION_ROLES` give way to `Station`; `evidence.turn` is named for what it records.
- **Operator–worker communication** — one design for how the operator and workers talk, with the operator as the only hub. The operator briefs a reviewer but never forwards the builder's arguments to it, and every message the operator sends a worker is an event, so a relay would show in the record.
- **Order dependencies** — `dim order add --needs <order>`, and `dim order ready` lists only orders whose dependencies have shipped, so orders that must not run side by side are ordered by the record.
- **The factory picks its own work** — select ready orders and run a bounded count, with claims and integration serialized.
- **Retake a failed order once** — a second failure leaves it.
- **Plan and review against a spec** — a repo's spec states what holds; the plan names the requirements an order touches and proposes the spec changes it makes, and review checks the diff against them.
- **Codex workers stop at their answer** — find out whether one can leave work running, and turn that off if so.
- **Cursor** — its sessions read into the record, its hooks installed, and station workers run under `cursor-agent` the way Claude Code, Codex, and Grok Build do.
- **More harnesses** — Qwen Code, Kimi CLI, Antigravity, and Pi, each able to start and resume a station worker the way Claude Code, Codex, and Grok Build do.
- **Reasoning effort per tier** — a harness that reasons, Grok, chooses effort separately from the model and defaults to high. `routing.json` names one model per tier. The effort is set for that harness and omitted for the others.
- **A change summary before ship** — builder and reviewer each describe the change, read side by side.
- **Artifact check before operator review** — validate worker-authored Plan and Build Markdown against the artifact contract before the operator reads it. Parse the same GFM the wall renders; return empty sections and sections that use a list or table for a single point to the worker for revision. Check record references against the order's evidence and keep the result in the order record. Review Markdown is rendered from structured findings, where a single item is valid. Clarity and proportional length remain judgment calls under the artifact guidance, not fixed word or heading quotas.
- **Gates earn trust per kind of order** — over a lookback window with a minimum sample, the record shows which kinds of order the owner has stopped needing to read, and the wall marks them. Trust is asymmetric: a return or a revert demotes at once, and promotion happens only on the owner's word, citing the evidence ([`landscape.md`](landscape.md#earned-autonomy)).
- **Skill revision reuse** — report whether a changed skill loaded again, and name the versions the record could not identify ([`landscape.md`](landscape.md#session-records-and-gates)).
- **Commits name their order by trailer** — every commit the runner makes ends with `Order: <id>`, so `git log` alone ties a commit to its order and artifacts through a rebase. The commit gate admits that one trailer line.
- **Pull what every project repeats into `dim`** — commit checks, pre-push, worktree setup, ship scripts and CI checks each become one thing `dim` holds, and the per-project copy is deleted ([`findings.md`](findings.md), "The same script, five times, already drifted").
- **The owner's rules as per-repo defaults** — the comment ban is already a setting; the subject limit, shipping to the default branch, a required `AGENTS.md` and the anti-pattern review become settings a repo adopts rather than conditions of using `dim`.
- **Review against the anti-patterns** — a review dimension whose brief is [`agent-anti-patterns.md`](../skills/dim-audit/references/agent-anti-patterns.md), on the plan and on each diff.
- **Single-word commands** — `format-edit`, `check-command`, `check-commits` and the `install-*` commands take one word each, or become subcommands (`dim install hooks`), with the hook commands and docs moved in the same change.
- **Closed vocabularies are exhaustive at compile time** [schema] — one `as const` list per vocabulary feeds both its type and its `CHECK`: `dimension` (both finding tables), `session.tool`, attempt `harness` and `tier` have none, and priority, role, artifact kind, severity, answer and the outcome lists are hand copies. `Tool` and `HarnessName` become one list; `running` stops being an attempt outcome; `finding.ts` `Answer` and `FindingAnswer` become one; `order-ship-run.ts` `code` takes the refusal codes.
- **One judge per gate** — hooks, the runner, CI and order completion call the same check.
- **The check read through the workspace detectors.**
- **Checks from more manifests** — `pubspec.yaml` first.
- **A new worktree installs its dependencies** from the lockfile.
- **`dim adopt`** — bring an existing repo under `dim` in one command, including one with a weak or missing check: purge and ban comments, declare check and format, install the commit gate, identify its style guide, run a baseline audit, and name what needs judgement.
- **Linux scheduled sync** — install and load a systemd user timer for `dim sync`, with `dim doctor` reporting whether it runs, as launchd does on macOS.
- **Catch a stuck slice** retried across sessions.
- **Wall gaps** — a silence threshold, station moves, durable worker names, the project on the card, and operator presence.
- **Wall notifications** — held and failed orders reach the owner off the page.
- **A check shows as passed or failed**, not as its command.
- **Wall tests render the page** — `src/wall/client.test.tsx` greps its own source for class strings, so it fails on a restyle and passes on a broken render.
- **Refuse blind staging** — `git add -A`, `.` and `--all`.
- **Record a commit's files** from the commit itself.
- **Record the check the commit gate runs.**
- **Refuse git aimed outside the session's checkout.**
- **Warn when a test is weakened** — a skip marker added, or assertions dropped.
- **Derive the schema version** and the rebuild drop list instead of declaring them.
- **Intake from files and issue trackers.**
- **Run orders from a schedule.**
- **Scheduled architecture review** when a boundary changes.
- **A recurring problem becomes an order** carrying the rows that found it.
- **A self-maintaining loop** — in a repo that ships apps, fix the top crash on a schedule.
- **Dart for the comment gate.**
- **Worktrees under `.agents/worktrees/`.**
- **Search by meaning over transcripts and commits** — embed what people and agents said to each other, each turn's final answer and commit subjects, refreshed by `dim sync`, and prove with a retrieval benchmark that it beats `q search`'s keywords before `q search` ranks by it.
- **Find code by meaning**, not only by path.
- **Undo an agent's writes** ([`worktrees.md`](worktrees.md)).
- **Messages between running sessions.**
- **Gates for US spelling** and for banner comments outside JS and TS.

## Owner decides

- Rename the `dim.ship = trunk` setting to `merge`.
- Should the comment gate refuse `biome-ignore` and `@ts-*`?
- Which features become settings that `dim doctor` fails when on but not set up?
- How does a repo declare its isolation strategy?
- Does an unattended self-maintaining run push, or commit locally?
- Does the wall become where the owner reads artifacts and approves, rather than only watches?
- Is `dim` for one owner, or for teams with several?
- Sunset handoffs once the factory is live? An order and its resumed worker replace the next move a handoff carries.
- [`design.md`](design.md) keeps each table's reason beside it in `db-schema.ts`, while the rules ban comments: 56 SQL comment blocks, some stale, plus rationale comments in `wall/styles.css` and the generated hooks. Which rule holds?
- Repo identity is `project`, `repo` and `label`, sometimes a path and sometimes owner/repo, and `finding.repo`'s comment prescribes a join that returns nothing. "Finding" names review findings, checking-agent findings and measurements; "trunk" and "default branch" name one thing; an attempt's `run_id` shadows the ship run; the glossary lacks repo, checkout, round, assignment, brief, runner and runner barrier. Which words?
- Are `finding` and `factory_order_finding` one concept? `q findings` reads only the first.

## Waiting on data

- Corrections as a source — no corrections are labeled yet.
- `q repeats` by meaning rather than a word list, once labels exist.
- Whether checked slices draw fewer later fixes, and whether the simplification pass pays.
- Picking code to simplify from what keeps drawing fixes.
- Why files edited under `agents-md` draw more fixes afterward.
- A record of which guidance cuts a measurement settled.
- Whether any unmarked or v1 spool hook is still installed, so `hooks.ts` `hookKind` can drop the retired shapes it recognises only to replace them.
- Whether macOS `date +%s%N` prints nanoseconds: if it prints a literal `N`, every spool name fails `SPOOL_NAME` and no operator can register.
- Whether Codex records a typed prompt as an event, so `ingest-parse-codex.ts` can drop its prompt-source regex; and the real usage-limit window, so `q burn` can drop its epoch-aligned five-hour blocks.
