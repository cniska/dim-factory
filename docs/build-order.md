# Build order

What is not built, and what each piece waits on. Every item is designed in the doc that argues for it, and this page links there rather than restating it — the order is the part that lives nowhere else, and an item whose design drifts from its home page would otherwise have two authorities.

An item is listed here only while it needs a slice of its own. Anything fixable where it was found is fixed there instead.

## The measurement comes before any ranking change

`q search` ranks by cosine, and `dim bench` now says how well: it answers roughly half the labeled questions and misses the rest outright ([`findings.md`](findings.md)). So a tuning below can be scored against that set rather than argued, which is the rule [`recall.md`](recall.md) sets for itself. What the set cannot yet say is whether cosine beats the keyword index it replaced, since only one of them is scored.

The corpus-native half of the measurement is built: `dim bench` scores a hand-labeled `retrieval.jsonl` by recall@k and nDCG@k through the queries themselves, and reports a first number ([`findings.md`](findings.md)). What is left:

- **The external set** ([`recall.md`](recall.md)). LongMemEval is what a published claim is made against, so it is the only way such a claim becomes checkable here. Its dataset adapters are the part that transfers from Acolyte's harness; the metrics were written here.

- **A corpus wider than one hand.** The labeled set is small and every question in it was written by one agent in one sitting, so it reports what that agent thought to ask. `handoff_link` pairs a handoff with the session that acted on it, which is a query and its known answer that nobody had to invent — drawing questions from there is what makes the set larger than an opinion.

- **Telling two passages in one session apart.** `search` prints a session for a message hit, so a message is graded by the session it sits in and two graded passages from one session cannot be separated; `bench` refuses such a question rather than scoring it wrong. A decision is usually one passage, not a whole session, so this is what stands between the corpus and the questions it most wants to ask.

## Waiting on that measurement

- **Reciprocal-rank fusion** ([`landscape.md`](landscape.md)). The borrow table carries the shape, including why it is not a drop-in.
- **A ledger of which guidance cuts measurement confirmed or rejected.** Append-only, written when a cut is decided by the runner. Distinct from the rejected-changes ledger [`evals-and-hooks.md`](evals-and-hooks.md) declines: that one records proposals turned down and is a multi-contributor artifact `git log` already covers, while this records what a measurement settled, which `git log` does not hold. It waits on the first measured cut — a ledger with no rows is the empty table that argument rejected.
- **Whether raw conversation turns belong in the index** ([`recall.md`](recall.md)). Measured worse as retrieval input, so this is a question for the benchmark and not a default.

## Waiting on a judgment only the owner can record

- **A self-maintaining loop, in a repo that ships apps.** Pick the fault worth fixing from the crash reports its own service collects, and run `dim-fix` on it, on a schedule. Most of it exists there already: a script groups faults by fingerprint with a count and will hand the same rows to a machine rather than a reader, and the repo declares its own check, so the `pre-commit` gate holds under a run nobody is watching.

  Two things are not built. The loop needs a memory of what it already attempted, and that cannot be derived — a subject is capped at fifty characters with no body, so a fault id cannot ride along in a commit. It belongs beside the reports, keyed on the fingerprint, which also yields the outcome signal this repo lacks: a fault that stops arriving from versions above the one it was fixed in.

  It lives there rather than here, because reading those reports needs the network and a credential, which the invariant at the top of [`src/cli.ts`](../src/cli.ts) refuses. What is the owner's: whether an unattended run pushes, or commits locally and leaves the work to be read.

- **Corrections as a source.** `correction_label` holds no rows, so the source that would catch a reworded repetition is empty, and `q repeats` cannot see one either ([`findings.md`](findings.md)). `dim q candidates` narrows and `dim label` records; nothing here labels itself, by design.

## Waiting on `PostToolUse` being installed

dim installs session hooks only, so anything reacting to a single tool call has no channel yet. Installing that event is the borrow [`landscape.md`](landscape.md) picks first, because it waits on nothing and the items below wait on it.

- **Running a formatter after an edit**, which is the half of the project tier dim can supply a command for but never run ([`recall.md`](recall.md)).
- **The working-directory check.** Git aimed outside the session's own directory fails three times as often ([`findings.md`](findings.md)). A commit hook knows the repo it runs in and not the one the session belongs to, so only a hook on the tool call can compare them.
- **Undoing an agent's writes** ([`worktrees.md`](worktrees.md)), which records that something changed and commits on a later pass.
- **The weakening guard** ([`evals-and-hooks.md`](evals-and-hooks.md)), which warns rather than blocks.

## Ready, waiting on nothing

- **The tooling chain in `wake`** ([`recall.md`](recall.md)), which is the half of the project tier the record answers rather than the manifest: which CLIs a repo is actually worked with, derived from the shell commands its sessions ran. The declared half is delivered. What has to be settled is how a CLI worth naming is told from one every repo uses, without a written list of interesting tools — a share measured against the corpus is the shape, and the threshold is the part that needs deciding rather than picking.

- **`src/jsonc.ts` is half a path module and half a text module.** `readJsonc` takes a path and does its own IO while `appendToJsoncArray` takes text, so `installHooks` reads each config a second time and re-implements the absent-file rule the reader already encodes. Every future writer — removing a hook, editing the Codex config — repeats the exists, read, append, check, back up, write sequence. Either the module grows a path-level edit and `hooks.ts` keeps only the backup policy, or the reader drops its IO and callers pass text.

- **Two small edit infidelities.** A comment trailing the last element of an array ends up labeling the entry appended after it, because the insertion point is the end of the previous element and not the end of its line. And an edited object in a CRLF file comes back with LF line endings. Both are `jsonc-parser` behaviors rather than mistakes here, neither loses a value, and neither has a caller complaining yet.

- **A stuck-slice counter.** A slice that keeps failing the repo's check and being re-attempted is invisible to the loop today. Ferment blocks a step after three starts without a completion ([`landscape.md`](landscape.md)); the record here spans sessions, so it can see a slice retried once per session across four, which a per-run state file cannot.

- **A finding gets an answer, and the loop ends on answered rather than on fixed.** `AGENTS.md` already states the rule — the builder fixes a finding or records why not — and nothing holds it: a checker reports once, the builder acts or does not, and nothing re-reads the corrected diff. The re-check is cheap because it reads only the diff that answers, which is smaller than the slice each round. The fixpoint is no unanswered finding, never no findings: a checker asked whether anything could still be improved always says yes, and a wrong finding fixed to end the argument makes the wrong thing the standard. This lands as station text, because whether a fix answers a finding is the judgement the checker is there for and no gate can hold it.

- **Findings recorded as rows, with how each was answered.** A finding exists only in the session that raised it, so what a checker caught is gone when the session is, and the arm that would say whether checking pays cannot be built. One row per finding — slice, dimension, file, and the answer: fixed, or refused with the reason. Two constraints come with it. It grades the checker, never the builder: [`findings.md`](findings.md) records three separate measures that looked like grades and turned out to track what was being worked on, and a findings count is the next of them — a builder scored down by it writes duller slices, and a checker scored up by it invents findings. And a findings row has no source to re-read, so it is the second table after `hook_event` that `dim rebuild` cannot restore, which is a durable-state decision rather than another derived view.

- **A judge for a refused finding.** The builder decides today whether a checker's finding was right, which is the one call the builder cannot make about its own work. A third agent, fired only on a refusal, is cheap and proportional. Its remit is the verifiable half — is the finding's claim true at its source, cited to `file:line` — because taste has no source to check and an agent handed two opinions grades rhetoric. Nobody judges the judge; its call is recorded and the appeal is `q fixes` on that file later. The failure to watch for: if refusing costs the builder anything, it fixes everything to avoid the judge, which is the run-until-fixed loop by another name.

- **`q keywords` ANDs every word, so a question rarely matches.** Asked "benchmark recall known relevant questions ranking" on 2026-09-17, it returned nothing while the subject was sitting in the record. Every term is required, so a natural-language question of six words needs all six in one message. The door was built for questions and answers best to two or three words, which is not what anyone will type. What to do is the decision: rank by how many terms matched rather than requiring all, or say plainly in the query's own output that it wants few words.

- **Whether the simplification pass in `dim-build` pays.** The step is built and every slice now carries it, so it spends on each one; nothing measures what it returns. What would answer it is an arm — slices run with the pass against slices run without — and `q fixes` over the files each touched. Until then the step rests on the owner's own practice, which is a reason to build it and not a measurement.

- **The aimed simplification pass**, which is the different question: which code that no slice just touched has earned one, read off `q fixes`, `q rework` and `q exemplars` rather than off whatever is open. This is where the measurement in [`findings.md`](findings.md) applies. Two pieces follow rather than block it: the unmodified-tests rule as a hook, and a catalog of smells as one agent per smell with a fixed brief, of which only file length, parameter count and duplicate blocks are shapes a gate can hold.

- **Why files edited under `agents-md` draw four times more fixes afterward than before** ([`findings.md`](findings.md)), on the largest station sample measured. Nothing explains it, and it is the shape every other station was checked for and cleared of.

- **The generated conventions block** ([`conventions.md`](conventions.md)), which that writer is the precondition for. Its first condition is now met — three gates exist and `doctor` reports both a missing hook and a checkout where the push gate cannot fire — and its second is not: `loop.md` requires each cut recorded as characters removed against the calls they would have stayed resident for, and the three rules cut from `~/.claude/CLAUDE.md` on 2026-09-17 were cut by hand and never measured. Do that measurement before generating anything.
- **A gate for US spelling, and one for banner comments.** The two rules left in the conventions file that a mechanism could hold. Everything else there needs judgement and stays written ([`conventions.md`](conventions.md)).
- **Slice 1 of the eval runner** ([`evals-and-hooks.md`](evals-and-hooks.md)): the trimmed arm and the rule inventory.
- **A guidance-file arm for that runner.** [`loop.md`](loop.md) names the boundary: a rule inside `~/.claude/CLAUDE.md` has no seam the runner can deliver a trimmed version through, so a guidance cut is decided by reading. An arm built as a whole config directory is what closes it, and a trimmed surface has to be unlinked and written fresh inside the arm — writing through the symlink edits the real guidance, and only a test that reddens on that keeps it true.
- **An index over code by meaning.** `prior-art` matches a path fragment, so a concept whose file is named for its domain is invisible to it — `lexer` returns nothing across 22 repos while `acolyte/src/log-parser.ts` is on disk ([`findings.md`](findings.md)). `q search` is semantic but covers only the text a person distilled. What is missing is the question "have we solved this shape before" where the shape is not in the filename. A ranking change can now be scored rather than preferred, so what this needs is questions of its own: `dim bench` grades what a query prints, and no query prints a file path as a ref today.
- **Extracting the toolchain that repeats.** Three of the drifted scripts are jobs this repo already does once, so that part is deleting forks ([`findings.md`](findings.md), [`README.md`](../README.md)). The `mise` and env handling across five checkouts is the part that has to be built.

## Deliberately not next

- **Generating the machine-held half of the conventions** ([`conventions.md`](conventions.md)). The work is building gates and earning one cut each; nothing generates a block until there are gates to hold the rules.
- **The routing tier** ([`evals-and-hooks.md`](evals-and-hooks.md)). Revisited only if telemetry shows misroutes that fixing by reading did not close.

- **A markdown writer that replaces a heading's byte range.** The property it exists for is real — a `##` inside a fenced code block is not a heading, and only an AST holds that. But its only caller is the generated conventions block, which waits on a measurement nobody has taken, so building it now produces a tested module with nothing to call it.

## Decided against

Not waiting on anything, and not queued. [`landscape.md`](landscape.md) records each with its reason, so the next survey does not raise it again, and that table is the list rather than this line.

The portability gap the watcher would have closed stands on its own: `install-agent` writes a launchd plist, so the scheduled sync is macOS-only.

