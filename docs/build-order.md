# Build order

What is not built, and what each piece waits on. Every item is designed in the doc that argues for it, and this page links there rather than restating it — the order is the part that lives nowhere else, and an item whose design drifts from its home page would otherwise have two authorities.

An item is listed here only while it needs a slice of its own. Anything fixable where it was found is fixed there instead.

## The measurement comes before any ranking change

`q search` ranks by cosine today and nothing says that beats the keyword index it replaced ([`findings.md`](findings.md)). Until something does, every tuning below is a preference, which is the rule [`recall.md`](recall.md) sets for itself. Two pieces, in this order, because the first produces the input the second needs:

1. **The handoff chain** ([`recall.md`](recall.md)). The edge linking a session to the one it continues. It pays twice: per-session measures stop being distorted by chain depth, and a Next paired with the session that acted on it is a query with a known answer. Recoverable from text already collected, so nothing has to be captured as it happens.
2. **The benchmark** ([`recall.md`](recall.md)). The metrics and dataset adapters transfer from Acolyte's harness; its scenario layer does not. The external set makes a published claim checkable here, and the corpus-native set from (1) is the one that decides changes.

## Waiting on that measurement

- **Reciprocal-rank fusion** ([`landscape.md`](landscape.md)). The borrow table carries the shape, including why it is not a drop-in.
- **A ledger of which guidance cuts measurement confirmed or rejected.** Append-only, written when a cut is decided by the runner. Distinct from the rejected-changes ledger [`evals-and-hooks.md`](evals-and-hooks.md) declines: that one records proposals turned down and is a multi-contributor artifact `git log` already covers, while this records what a measurement settled, which `git log` does not hold. It waits on the first measured cut — a ledger with no rows is the empty table that argument rejected.
- **Whether raw conversation turns belong in the index** ([`recall.md`](recall.md)). Measured worse as retrieval input, so this is a question for the benchmark and not a default.

## Waiting on a judgment only the owner can record

- **Corrections as a source.** `correction_label` holds no rows, so the source that would catch a reworded repetition is empty, and `q repeats` cannot see one either ([`findings.md`](findings.md)). `dim q candidates` narrows and `dim label` records; nothing here labels itself, by design.

## Waiting on `PostToolUse` being installed

dim installs session hooks only, so anything reacting to a single tool call has no channel yet. Installing that event is the borrow [`landscape.md`](landscape.md) picks first, because it waits on nothing and these three wait on it.

- **Running a formatter after an edit**, which is the half of the project tier dim can supply a command for but never run ([`recall.md`](recall.md)).
- **Undoing an agent's writes** ([`worktrees.md`](worktrees.md)), which records that something changed and commits on a later pass.
- **The weakening guard** ([`evals-and-hooks.md`](evals-and-hooks.md)), which warns rather than blocks.

## Ready, waiting on nothing

- **The per-repo project tier in `wake`** ([`recall.md`](recall.md)): declared tasks read from the repo, tooling chain derived from the record. The formatter hook above is a later half of the same profile, not a prerequisite for it.
- **Slice 1 of the eval runner** ([`evals-and-hooks.md`](evals-and-hooks.md)): the trimmed arm and the rule inventory.
- **A guidance-file arm for that runner.** [`loop.md`](loop.md) names the boundary: a rule inside `~/.claude/CLAUDE.md` has no seam the runner can deliver a trimmed version through, so a guidance cut is decided by reading. An arm built as a whole config directory is what closes it, and a trimmed surface has to be unlinked and written fresh inside the arm — writing through the symlink edits the real guidance, and only a test that reddens on that keeps it true.
- **Extracting the toolchain that repeats.** Three of the drifted scripts are jobs this repo already does once, so that part is deleting forks ([`findings.md`](findings.md), [`README.md`](../README.md)). The `mise` and env handling across five checkouts is the part that has to be built.
- **Reporting a line the parser dropped.** A complete line that is not valid JSON is skipped and the cursor advances past it (`src/parse-claude.ts`), which is the only option that does not stall collection on one corrupt record — but it is silent: uncounted, and absent from `sync`'s failures. The work is counting and surfacing it, not refusing the file. Described here because it is a defect rather than a design, so no other page argues for it.
- **Recording the guidance walk at session start.** `guidance_version` hashes each rules file it finds, but not the walk that assembled it: which surfaces were in force together, and which file imported another. `wake` already runs as a `dim` process on `SessionStart`, so it is where a sha per surface plus the importing file can be written. Session granularity, so an edit made mid-session is missed — which is the honest limit, not a reason to reach for per-turn capture.

## Deliberately not next

- **Generating the machine-held half of the conventions** ([`conventions.md`](conventions.md)). The work is building gates and earning one cut each; nothing generates a block until there are gates to hold the rules.
- **The routing tier** ([`evals-and-hooks.md`](evals-and-hooks.md)). Revisited only if telemetry shows misroutes that fixing by reading did not close.

## Decided against

Not waiting on anything, and not queued. [`landscape.md`](landscape.md) records each with its reason, so the next survey does not raise it again: a watcher in place of the polling agent, a parser widened to a third tool, chunking below a heading, a cursor for the embedding pass, remote embedding providers, a vector database, and dashboards.

The portability gap the watcher would have closed stands on its own: `install-agent` writes a launchd plist, so the scheduled sync is macOS-only.

## One step that is not build work

Scratch-tree commits ingested before the rule existed are still in the database; the rule only stops new ones ([`design.md`](design.md)). They leave on the next `dim rebuild`, and the next `dim embed` then drops their vectors, because the index is a projection of its sources.
