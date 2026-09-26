# Todo

What is not built, highest priority first. `dim order ready` lists what is queued. An item stays here only while it needs work of its own; anything fixable where it was found is fixed there.

## Bugs

1. A failed attempt puts a started order back in the queue. The order lifecycle fixes it: a started order stays active and resumes at its station.
2. A database transaction that reads before it writes fails at once when another writer holds the lock, instead of waiting.
3. A worker can read the operator's credential and the model routing in `dim`'s data directory.
4. A worker that dies without recording a finish leaves its attempt running forever.
5. `dim rebuild` silently drops a renamed column of a factory table, or fails partway; it should list what it cannot carry before dropping anything.
6. A slice can reach review without a Build artifact of its own.
7. A moved checkout reads as a second repo.
8. `q keywords` prints no ref, so benchmark questions asked of it cannot be scored.
9. Two label counts can include labels whose message is gone.
10. Editing a JSONC file moves a trailing array comment onto the new entry, and turns CRLF into LF.

## Features

1. **Order lifecycle** — one state machine read from the record, checked by each of plan, build, review and ship on entry. No `dim order move`, no return to the queue, ship ends the order, and only statuses that cannot be derived are stored.
2. **Ship and rebase records** — one table for ship outcomes and one for rebases, replacing the delivery rows and event JSON, shaped for pull-request shipping as well as trunk.
3. **An attempt for every station run** — planner and reviewer runs claim the order too, and the order's worker folds into its assignment.
4. **Order table cleanup** — a station constraint, per-kind event references, stale columns dropped, and events for amend, priority and hold.
5. **Operator–worker communication** — one design for how the operator and workers talk.
6. **The factory picks its own work** — select ready orders and run a bounded count, with claims and integration serialized.
7. **Retake a failed order once** — a second failure leaves it.
8. **Fix orders triage first** — diagnose the cause, prove the test catches the bug, and review against the named cause.
9. **Codex workers stop at their answer** — find out whether one can leave work running, and turn that off if so.
10. **A change summary before ship** — builder and reviewer each describe the change, read side by side.
11. **Gates earn trust per kind of order** — over a lookback window with a minimum sample, the record shows which kinds of order the owner has stopped needing to read, and the wall marks them. Trust is asymmetric: a return or a revert demotes at once, and promotion happens only on the owner's word, citing the evidence ([`landscape.md`](landscape.md#earned-autonomy)).
12. **Artifacts linked to commits by trailer** — so an order's plan, Build and Review artifacts stay attached to its commits through a rebase.
13. **Review against the anti-patterns** — a review dimension whose brief is [`agent-anti-patterns.md`](agent-anti-patterns.md), on the plan and on each diff.
14. **Closed vocabularies are exhaustive at compile time.**
15. **One judge per gate** — hooks, the runner, CI and order completion call the same check.
16. **The check read through the workspace detectors.**
17. **Checks from more manifests** — `pubspec.yaml` first.
18. **A new worktree installs its dependencies** from the lockfile.
19. **`dim adopt`** — bring a repo under `dim` in one command: purge and ban comments, declare check and format, install the commit gate.
20. **`/dim-setup`** — set up from a fresh clone, ending on `dim doctor` passing.
21. **Catch a stuck slice** retried across sessions.
22. **Hold on a checker's refusal** the way review refusals are held.
23. **Wall gaps** — a silence threshold, station moves, durable worker names, the project on the card, and operator presence.
24. **Wall notifications** — held and failed orders reach the owner off the page.
25. **A check shows as passed or failed**, not as its command.
26. **`dim q order` in columns** rather than one packed cell.
27. **Refuse blind staging** — `git add -A`, `.` and `--all`.
28. **Record a commit's files** from the commit itself.
29. **Record the check the commit gate runs.**
30. **Refuse git aimed outside the session's checkout.**
31. **Warn when a test is weakened** — a skip marker added, or assertions dropped.
32. **Derive the schema version** and the rebuild drop list instead of declaring them.
33. **Intake from files and issue trackers.**
34. **Run orders from a schedule.**
35. **Scheduled architecture review** when a boundary changes.
36. **A recurring problem becomes an order** carrying the rows that found it.
37. **A self-maintaining loop** — in a repo that ships apps, fix the top crash on a schedule.
38. **Dart for the comment gate.**
39. **Worktrees under `.agents/worktrees/`.**
40. **Format after an edit** with the repo's declared format task.
41. **An external retrieval benchmark** (LongMemEval).
42. **A wider benchmark corpus** drawn from handoffs and the sessions that acted on them.
43. **Find code by meaning**, not only by path.
44. **The repo's tooling in `wake`**, if it earns its tokens.
45. **Undo an agent's writes** ([`worktrees.md`](worktrees.md)).
46. **Messages between running sessions.**
47. **Gates for US spelling** and for banner comments outside JS and TS.
48. **Extract the repeated toolchain** setup across checkouts.

## Owner decides

- Rename "trunk" to "default branch", and `dim.ship = trunk` to `merge`?
- Should the comment gate refuse `biome-ignore` and `@ts-*`?
- Which features become settings that `dim doctor` fails when on but not set up?
- How does a repo declare its isolation strategy?
- Does an unattended self-maintaining run push, or commit locally?

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
