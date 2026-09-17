# Build order

What is not built, and what each piece waits on. Every item is designed in the doc that argues for it, and this page links there rather than restating it — the order is the part that lives nowhere else, and an item whose design drifts from its home page would otherwise have two authorities.

An item is listed here only while it needs a slice of its own. Anything fixable where it was found is fixed there instead.

## The measurement comes before any ranking change

`q search` ranks by cosine today and nothing says that beats the keyword index it replaced ([`findings.md`](findings.md)). Until something does, every tuning below is a preference, which is the rule [`recall.md`](recall.md) sets for itself.

The chain that pairs a handoff with the session that acted on it is built, so the pairs the corpus-native set is drawn from exist. What is left is the measurement:

- **The benchmark** ([`recall.md`](recall.md)). The metrics and dataset adapters transfer from Acolyte's harness; its scenario layer does not. The external set makes a published claim checkable here, and the corpus-native set drawn from `handoff_link` is the one that decides changes.

## Waiting on that measurement

- **Reciprocal-rank fusion** ([`landscape.md`](landscape.md)). The borrow table carries the shape, including why it is not a drop-in.
- **A ledger of which guidance cuts measurement confirmed or rejected.** Append-only, written when a cut is decided by the runner. Distinct from the rejected-changes ledger [`evals-and-hooks.md`](evals-and-hooks.md) declines: that one records proposals turned down and is a multi-contributor artifact `git log` already covers, while this records what a measurement settled, which `git log` does not hold. It waits on the first measured cut — a ledger with no rows is the empty table that argument rejected.
- **Whether raw conversation turns belong in the index** ([`recall.md`](recall.md)). Measured worse as retrieval input, so this is a question for the benchmark and not a default.

## Waiting on a judgment only the owner can record

- **Corrections as a source.** `correction_label` holds no rows, so the source that would catch a reworded repetition is empty, and `q repeats` cannot see one either ([`findings.md`](findings.md)). `dim q candidates` narrows and `dim label` records; nothing here labels itself, by design.

## Waiting on `PostToolUse` being installed

dim installs session hooks only, so anything reacting to a single tool call has no channel yet. Installing that event is the borrow [`landscape.md`](landscape.md) picks first, because it waits on nothing and these three wait on it.

- **Running a formatter after an edit**, which is the half of the project tier dim can supply a command for but never run ([`recall.md`](recall.md)).
- **The working-directory check.** Git aimed outside the session's own directory fails three times as often ([`findings.md`](findings.md)). A commit hook knows the repo it runs in and not the one the session belongs to, so only a hook on the tool call can compare them.
- **Undoing an agent's writes** ([`worktrees.md`](worktrees.md)), which records that something changed and commits on a later pass.
- **The weakening guard** ([`evals-and-hooks.md`](evals-and-hooks.md)), which warns rather than blocks.

## Ready, waiting on nothing

- **The per-repo project tier in `wake`** ([`recall.md`](recall.md)): declared tasks read from the repo, tooling chain derived from the record. The formatter hook above is a later half of the same profile, not a prerequisite for it.
- **A `pre-push` gate against rewriting a shared branch.** The record holds 72 force pushes, 242 `reset --hard` and 207 amends ([`findings.md`](findings.md)), and the rule against them is written in a skill that two thirds of the committing sessions never load. A push that is not a fast-forward of the branch the remote's HEAD names is the shape a hook can read.
- **`dim-git`, the station for the judgement half.** Which convention a repo holds, whether it branches or commits straight to the integration branch, and which of its files came back — all rows in `repo_commit` and `commit_file` today, and all of it guessed from `git log` by the tool-agnostic skill. What is mechanical goes to the gate above instead, because the load rate is the thing that fails.
- **Slice 1 of the eval runner** ([`evals-and-hooks.md`](evals-and-hooks.md)): the trimmed arm and the rule inventory.
- **A guidance-file arm for that runner.** [`loop.md`](loop.md) names the boundary: a rule inside `~/.claude/CLAUDE.md` has no seam the runner can deliver a trimmed version through, so a guidance cut is decided by reading. An arm built as a whole config directory is what closes it, and a trimmed surface has to be unlinked and written fresh inside the arm — writing through the symlink edits the real guidance, and only a test that reddens on that keeps it true.
- **An index over code by meaning.** `prior-art` matches a path fragment, so a concept whose file is named for its domain is invisible to it — `lexer` returns nothing across 22 repos while `acolyte/src/log-parser.ts` is on disk ([`findings.md`](findings.md)). `q search` is semantic but covers only the text a person distilled. What is missing is the question "have we solved this shape before" where the shape is not in the filename. Waits on the benchmark, like every other ranking change.
- **Extracting the toolchain that repeats.** Three of the drifted scripts are jobs this repo already does once, so that part is deleting forks ([`findings.md`](findings.md), [`README.md`](../README.md)). The `mise` and env handling across five checkouts is the part that has to be built.

## Deliberately not next

- **Generating the machine-held half of the conventions** ([`conventions.md`](conventions.md)). The work is building gates and earning one cut each; nothing generates a block until there are gates to hold the rules.
- **The routing tier** ([`evals-and-hooks.md`](evals-and-hooks.md)). Revisited only if telemetry shows misroutes that fixing by reading did not close.

## Decided against

Not waiting on anything, and not queued. [`landscape.md`](landscape.md) records each with its reason, so the next survey does not raise it again: a watcher in place of the polling agent, a parser widened to a third tool, chunking below a heading, a cursor for the embedding pass, remote embedding providers, a vector database, and dashboards.

The portability gap the watcher would have closed stands on its own: `install-agent` writes a launchd plist, so the scheduled sync is macOS-only.

