# Todo

What is not built, highest priority first. `dim order ready` lists what is queued. An item stays here only while it needs work of its own; anything fixable where it was found is fixed there.

## Bugs

- A builder can write `sessions.db` directly, since its sandbox grants `dim`'s data directory, so it can forge a row no `dim` command would write.
- A moved checkout reads as a second repo.
- Editing a JSONC file moves a trailing array comment onto the new entry, and turns CRLF into LF.

## Features

- **Refuse a secret at ship** — an order's diff carrying a key shape is not shipped.
- **Ship through a pull request** — `dim.ship = pull-request`, since most repos do not fast-forward their default branch. Built against one of the owner's repos that ships by PR, once the factory runs again.
- **Order table cleanup** — per-kind event references, stale columns dropped, and events for amend and priority.
- **Order worker assignment cleanup** — the order's worker identity and provider session live in its assignment rather than in a second binding row.
- **Operator–worker communication** — one design for how the operator and workers talk, with the operator as the only hub. The operator briefs a reviewer but never forwards the builder's arguments to it, and every message the operator sends a worker is an event, so a relay would show in the record.
- **Order dependencies** — `dim order add --needs <order>`, and `dim order ready` lists only orders whose dependencies have shipped, so orders that must not run side by side are ordered by the record.
- **The factory picks its own work** — select ready orders and run a bounded count, with claims and integration serialized.
- **Retake a failed order once** — a second failure leaves it.
- **Plan and review against a spec** — a repo's `SPEC.md` states what holds; the plan names the requirements an order touches and proposes the spec changes it makes, and review checks the diff against them.
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
- **Closed vocabularies are exhaustive at compile time.**
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

## Waiting on data

- Corrections as a source — no corrections are labeled yet.
- `q repeats` by meaning rather than a word list, once labels exist.
- Whether checked slices draw fewer later fixes, and whether the simplification pass pays.
- Picking code to simplify from what keeps drawing fixes.
- Why files edited under `agents-md` draw more fixes afterward.
- A record of which guidance cuts a measurement settled.
