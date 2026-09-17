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

- **A self-maintaining loop, in a repo that ships apps.** Pick the fault worth fixing from the crash reports its own service collects, and run `dim-fix` on it, on a schedule. Most of it exists there already: a script groups faults by fingerprint with a count and will hand the same rows to a machine rather than a reader, and the repo declares its own check, so the `pre-commit` gate holds under a run nobody is watching. Two things are not built. The loop needs a memory of what it already attempted, and that cannot be derived — a subject is capped at fifty characters with no body, so a fault id cannot ride along in a commit. It belongs beside the reports, keyed on the fingerprint, which also yields the outcome signal this repo lacks: a fault that stops arriving from versions above the one it was fixed in. And the loop lives there rather than here, because reading those reports needs the network and a credential, which the invariant at the top of [`src/cli.ts`](../src/cli.ts) refuses. What is the owner's: whether an unattended run pushes, or commits locally and leaves the work to be read.

- **Corrections as a source.** `correction_label` holds no rows, so the source that would catch a reworded repetition is empty, and `q repeats` cannot see one either ([`findings.md`](findings.md)). `dim q candidates` narrows and `dim label` records; nothing here labels itself, by design.

## Waiting on `PostToolUse` being installed

dim installs session hooks only, so anything reacting to a single tool call has no channel yet. Installing that event is the borrow [`landscape.md`](landscape.md) picks first, because it waits on nothing and the items below wait on it.

- **Running a formatter after an edit**, which is the half of the project tier dim can supply a command for but never run ([`recall.md`](recall.md)).
- **The working-directory check.** Git aimed outside the session's own directory fails three times as often ([`findings.md`](findings.md)). A commit hook knows the repo it runs in and not the one the session belongs to, so only a hook on the tool call can compare them.
- **Undoing an agent's writes** ([`worktrees.md`](worktrees.md)), which records that something changed and commits on a later pass.
- **The weakening guard** ([`evals-and-hooks.md`](evals-and-hooks.md)), which warns rather than blocks.

## Ready, waiting on nothing

- **The tooling chain in `wake`** ([`recall.md`](recall.md)), which is the half of the project tier the record answers rather than the manifest: which CLIs a repo is actually worked with, derived from the shell commands its sessions ran. The declared half is delivered. What has to be settled is how a CLI worth naming is told from one every repo uses, without a written list of interesting tools — a share measured against the corpus is the shape, and the threshold is the part that needs deciding rather than picking.
- **Structural writers for the files dim edits.** Markdown and JSON are both rewritten today by reading, replacing and writing whole: `install-rules` overwrites its output file, and `hooks.ts` round-trips the tool's config through `JSON.stringify`, discarding the reader's own formatting and failing outright on a comment. A markdown writer that finds a heading node by its byte range cannot mistake a `##` inside a fenced block for a real one, which is the property the generated block below has to rest on; `jsonc-parser` edits a config in place and leaves untouched bytes untouched.
- **The generated conventions block** ([`conventions.md`](conventions.md)), which that writer is the precondition for. Its first condition is now met — three gates exist and `doctor` reports both a missing hook and a checkout where the push gate cannot fire — and its second is not: `loop.md` requires each cut recorded as characters removed against the calls they would have stayed resident for, and the three rules cut from `~/.claude/CLAUDE.md` on 2026-09-17 were cut by hand and never measured. Do that measurement before generating anything.
- **A gate for US spelling, and one for banner comments.** The two rules left in the conventions file that a mechanism could hold. Everything else there needs judgement and stays written ([`conventions.md`](conventions.md)).
- **Slice 1 of the eval runner** ([`evals-and-hooks.md`](evals-and-hooks.md)): the trimmed arm and the rule inventory.
- **A guidance-file arm for that runner.** [`loop.md`](loop.md) names the boundary: a rule inside `~/.claude/CLAUDE.md` has no seam the runner can deliver a trimmed version through, so a guidance cut is decided by reading. An arm built as a whole config directory is what closes it, and a trimmed surface has to be unlinked and written fresh inside the arm — writing through the symlink edits the real guidance, and only a test that reddens on that keeps it true.
- **An index over code by meaning.** `prior-art` matches a path fragment, so a concept whose file is named for its domain is invisible to it — `lexer` returns nothing across 22 repos while `acolyte/src/log-parser.ts` is on disk ([`findings.md`](findings.md)). `q search` is semantic but covers only the text a person distilled. What is missing is the question "have we solved this shape before" where the shape is not in the filename. Waits on the benchmark, like every other ranking change.
- **Trimming what this repo's docs say about `cniska/skills`.** Three pages describe that repo's internals rather than this one's boundary with it: the eval instrument's landing place ([`evals-and-hooks.md`](evals-and-hooks.md)), the direction evidence flows ([`loop.md`](loop.md)), and `skill_version` built from its `git log -p` ([`design.md`](design.md)). Only the last is a live dependency of code here. The boundary itself — a station reads the record and ships here, a tool-agnostic skill works without a database and ships there — is worth one sentence; the rest is another repo's design kept in this one's docs, where it goes stale unwatched.
- **Extracting the toolchain that repeats.** Three of the drifted scripts are jobs this repo already does once, so that part is deleting forks ([`findings.md`](findings.md), [`README.md`](../README.md)). The `mise` and env handling across five checkouts is the part that has to be built.

## Deliberately not next

- **Generating the machine-held half of the conventions** ([`conventions.md`](conventions.md)). The work is building gates and earning one cut each; nothing generates a block until there are gates to hold the rules.
- **The routing tier** ([`evals-and-hooks.md`](evals-and-hooks.md)). Revisited only if telemetry shows misroutes that fixing by reading did not close.

## Decided against

Not waiting on anything, and not queued. [`landscape.md`](landscape.md) records each with its reason, so the next survey does not raise it again, and that table is the list rather than this line.

The portability gap the watcher would have closed stands on its own: `install-agent` writes a launchd plist, so the scheduled sync is macOS-only.

