# Todo

What is not built, highest priority first. `dim order ready` lists what is queued. An item stays here only while it needs work of its own; anything fixable where it was found is fixed there.

## Bugs

- A database transaction that reads before it writes fails at once when another writer holds the lock, instead of waiting.
- A worker can read the operator's credential and the model routing in `dim`'s data directory.
- A worker that dies without recording a finish leaves its attempt open. Nothing is refused by it, since an attempt whose worker is over does not count as running, but no finish is recorded.
- `dim rebuild` silently drops a renamed column of a factory table, or fails partway; it should list what it cannot carry before dropping anything.
- A slice can reach review without a Build artifact of its own.
- A moved checkout reads as a second repo.
- `q keywords` prints no ref, so benchmark questions asked of it cannot be scored.
- Two label counts can include labels whose message is gone.
- Editing a JSONC file moves a trailing array comment onto the new entry, and turns CRLF into LF.

## Features

- **One path per act** — the runner is the only writer of commits, files, checks and artifacts, so `dim order commit`, `file`, `check`, `build-artifact` and `review-artifact` go.
- **Ship and rebase records** — one table for ship refusals and one for rebases, replacing the conflict held in the `ship_failed` event's JSON.
- **Refuse a secret at ship** — an order's diff carrying a key shape is not shipped.
- **Ship through a pull request** — `dim.ship = pull-request`, since most repos do not fast-forward their default branch. Built against one of the owner's repos that ships by PR, once the factory runs again.
- **An attempt for every station run** — planner and reviewer runs claim the order too, and the order's worker folds into its assignment.
- **Order table cleanup** — per-kind event references, stale columns dropped, and events for amend and priority.
- **Operator–worker communication** — one design for how the operator and workers talk, with the operator as the only hub. The operator briefs a reviewer but never forwards the builder's arguments to it, and every message the operator sends a worker is an event, so a relay would show in the record.
- **The factory picks its own work** — select ready orders and run a bounded count, with claims and integration serialized.
- **Retake a failed order once** — a second failure leaves it.
- **Fix orders triage first** — diagnose the cause, prove the test catches the bug, and review against the named cause.
- **Codex workers stop at their answer** — find out whether one can leave work running, and turn that off if so.
- **A change summary before ship** — builder and reviewer each describe the change, read side by side.
- **Gates earn trust per kind of order** — over a lookback window with a minimum sample, the record shows which kinds of order the owner has stopped needing to read, and the wall marks them. Trust is asymmetric: a return or a revert demotes at once, and promotion happens only on the owner's word, citing the evidence ([`landscape.md`](landscape.md#earned-autonomy)).
- **Artifacts linked to commits by trailer** — so an order's plan, Build and Review artifacts stay attached to its commits through a rebase.
- **Pull what every project repeats into `dim`** — commit checks, pre-push, worktree setup, ship scripts and CI checks each become one thing `dim` holds, and the per-project copy is deleted ([`findings.md`](findings.md), "The same script, five times, already drifted").
- **The owner's rules as per-repo defaults** — the comment ban is already a setting; the subject limit, trunk-only shipping, a required `AGENTS.md` and the anti-pattern review become settings a repo adopts rather than conditions of using `dim`.
- **Review against the anti-patterns** — a review dimension whose brief is [`agent-anti-patterns.md`](agent-anti-patterns.md), on the plan and on each diff.
- **Single-word commands** — `format-edit`, `check-command`, `check-commits` and the `install-*` commands take one word each, or become subcommands (`dim install hooks`), with the hook commands and docs moved in the same change.
- **Closed vocabularies are exhaustive at compile time.**
- **One judge per gate** — hooks, the runner, CI and order completion call the same check.
- **The check read through the workspace detectors.**
- **Checks from more manifests** — `pubspec.yaml` first.
- **A new worktree installs its dependencies** from the lockfile.
- **`dim adopt`** — bring an existing repo under `dim` in one command, including one with a weak or missing check: purge and ban comments, declare check and format, install the commit gate, and name what needs judgement.
- **`/dim-setup`** — set up from a fresh clone, ending on `dim doctor` passing.
- **Catch a stuck slice** retried across sessions.
- **Wall gaps** — a silence threshold, station moves, durable worker names, the project on the card, and operator presence.
- **Wall notifications** — held and failed orders reach the owner off the page.
- **A check shows as passed or failed**, not as its command.
- **`dim q order` in columns** rather than one packed cell.
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
- **An external retrieval benchmark** (LongMemEval).
- **A wider benchmark corpus** drawn from handoffs and the sessions that acted on them.
- **Find code by meaning**, not only by path.
- **The repo's tooling in `wake`**, if it earns its tokens.
- **Undo an agent's writes** ([`worktrees.md`](worktrees.md)).
- **Messages between running sessions.**
- **Gates for US spelling** and for banner comments outside JS and TS.

## Owner decides

- Rename "trunk" to "default branch", and `dim.ship = trunk` to `merge`?
- Should the comment gate refuse `biome-ignore` and `@ts-*`?
- Which features become settings that `dim doctor` fails when on but not set up?
- How does a repo declare its isolation strategy?
- Does an unattended self-maintaining run push, or commit locally?
- Does the wall become where the owner reads artifacts and approves, rather than only watches?
- Is `dim` for one owner, or for teams with several?

## Waiting on data

- Corrections as a source — no corrections are labeled yet.
- `q repeats` by meaning rather than a word list, once labels exist.
- Fusing keyword and meaning ranks, and whether raw turns help retrieval — both wait on the benchmark.
- Whether checked slices draw fewer later fixes, and whether the simplification pass pays.
- Picking code to simplify from what keeps drawing fixes.
- Why files edited under `agents-md` draw more fixes afterward.
- A record of which guidance cuts a measurement settled.

## Known limits

- Scheduled sync is macOS only, since `install-agent` writes a launchd plist.
