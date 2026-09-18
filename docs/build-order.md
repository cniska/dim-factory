# Build order

What is not built, and what each piece waits on. Every item is designed in the doc that argues for it, and this page links there rather than restating it — the order is the part that lives nowhere else, and an item whose design drifts from its home page would otherwise have two authorities.

An item is listed here only while it needs a slice of its own. Anything fixable where it was found is fixed there instead.

## The measurement comes before any ranking change

`q search` ranks by cosine, and `dim bench` now says how well: it answers roughly half the labeled questions and misses the rest outright ([`findings.md`](findings.md)). So a tuning below can be scored against that set rather than argued, which is the rule [`recall.md`](recall.md) sets for itself. What the set cannot yet say is whether cosine beats the keyword index it replaced, since only one of them is scored.

The corpus-native half of the measurement is built: `dim bench` scores a hand-labeled `retrieval.jsonl` by recall@k and nDCG@k through the queries themselves, and reports a first number ([`findings.md`](findings.md)). What is left:

- **The external set** ([`recall.md`](recall.md)). LongMemEval is what a published claim is made against, so it is the only way such a claim becomes checkable here. Its dataset adapters are the part that transfers from Acolyte's harness; the metrics were written here.

- **Telling two passages in one session apart.** `search` prints a session for a message hit, so a message is graded by the session it sits in and two graded passages from one session cannot be separated; `bench` refuses such a question rather than scoring it wrong. A decision is usually one passage, not a whole session, so this is what stands between the corpus and the questions it most wants to ask, and it bounds the item below.

- **A corpus wider than one hand.** The labeled set is small and every question in it was written by one agent in one sitting, so it reports what that agent thought to ask. `handoff_link` pairs a handoff with the session that acted on it, which is a query and its known answer that nobody had to invent — drawing questions from there is what makes the set larger than an opinion. Until a passage can be told from its session, such a draw takes at most one question per session; the rest of the edges are unscorable.

## Waiting on that measurement

- **Reciprocal-rank fusion** ([`landscape.md`](landscape.md)). The borrow table carries the shape, including why it is not a drop-in.
- **A ledger of which guidance cuts measurement confirmed or rejected.** Append-only, written when a cut is decided by the runner. Distinct from the rejected-changes ledger [`evals-and-hooks.md`](evals-and-hooks.md) declines: that one records proposals turned down and is a multi-contributor artifact `git log` already covers, while this records what a measurement settled, which `git log` does not hold. It waits on the first measured cut — a ledger with no rows is the empty table that argument rejected.
- **Whether raw conversation turns belong in the index** ([`recall.md`](recall.md)). Measured worse as retrieval input, so this is a question for the benchmark and not a default.

## Waiting on a judgment only the owner can record

- **A self-maintaining loop, in a repo that ships apps.** Pick the fault worth fixing from the crash reports its own service collects, and run `dim-line-fix` on it, on a schedule. Most of it exists there already: a script groups faults by fingerprint with a count and will hand the same rows to a machine rather than a reader, and the repo declares its own check, so the `pre-commit` gate holds under a run nobody is watching.

  Two things are not built. The loop needs a memory of what it already attempted, and that cannot be derived — a subject is capped at fifty characters with no body, so a fault id cannot ride along in a commit. It belongs beside the reports, keyed on the fingerprint, which also yields the outcome signal this repo lacks: a fault that stops arriving from versions above the one it was fixed in.

  It lives there rather than here, because reading those reports needs the network and a credential, which the invariant at the top of [`src/cli.ts`](../src/cli.ts) refuses. What is the owner's: whether an unattended run pushes, or commits locally and leaves the work to be read.

- **Corrections as a source.** `correction_label` holds no rows, so the source that would catch a reworded repetition is empty, and `q repeats` cannot see one either ([`findings.md`](findings.md)). `dim q candidates` narrows and `dim label` records; nothing here labels itself, by design.

## Ready, waiting on nothing

- **The self-sufficient factory job.** [`factory.md`](factory.md) defines the job contract: one job owns one queue item in an isolated worktree, may delegate its internal work, runs to completion or a recorded stop, and leaves the driver to schedule, observe and integrate. The first driver slice is live: `runFactoryJob` claims one supplied item, passes its base revision to the builder, and records the builder's terminal outcome and evidence in `factory_job`, `factory_job_event`, and the existing commit, file, check, finding and document tables. `dim q factory [job-id-prefix]` reads the unified current-status row and `dim q job <job-id>` reads the detailed event report. Queue selection, serialized landing and queue-state enforcement remain for the orchestration slices. Independent jobs can run in parallel, while claims, landing and queue transitions stay serialized. The explicit item count is the run boundary and defaults to one.

- **A reversible queue planner.** The planned queue layer is a tracked file issue format plus a small Node or Bun CLI. It owns item intent, dependencies and queue status; it identifies unblocked work for parallel isolated jobs and writes status transitions back to the file. [`factory.md`](factory.md) keeps this boundary separate from the persisted `factory_job` execution report, whose claims, events and evidence remain the factory's operational record.

- **A harness-neutral factory scheduler.** [`factory.md`](factory.md) defines the boundary: `dim` owns schedule state, due selection and run evidence, while Codex, launchd, cron or another host only invokes it. The first slice is the schedule definition and read path; host installation remains outside it.

- **A scheduled architecture review.** A read-only `dim-station-review` pass uses the architecture dimension over a coherent group of changes or a change that crosses a module, schema, queue or hook boundary. It reports responsibility, contract and dependency drift separately from tests and slice checks; the review runs when the queue presents that boundary, not on an arbitrary timer.

- **`PostToolUse` as an installed event**, which records tool activity for the observable loop and clears the formatter and weakening guard below. It records that a call happened and a later pass reads the record, the way the session hooks spool rather than write, because a hook firing on every tool call that can fail is a hook that can break every session.

- **Running a formatter after an edit**, which is the half of the project tier dim can supply a command for but never run ([`recall.md`](recall.md)).

- **The working-directory check.** Git aimed outside the session's own directory fails three times as often ([`findings.md`](findings.md)). A commit hook knows the repo it runs in and not the one the session belongs to, so only a hook on the tool call can compare them.

- **The weakening guard** ([`evals-and-hooks.md`](evals-and-hooks.md)), which warns rather than blocks.

- **Undoing an agent's writes** ([`worktrees.md`](worktrees.md)), which records that something changed and commits on a later pass.

- **The tooling chain in `wake`** ([`recall.md`](recall.md)), which is the half of the project tier the record answers rather than the manifest: which CLIs a repo is actually worked with, derived from the shell commands its sessions ran. The declared half is delivered. What has to be settled is how a CLI worth naming is told from one every repo uses, without a written list of interesting tools — a share measured against the corpus is the shape, and the threshold is the part that needs deciding rather than picking.

- **`src/jsonc.ts` is half a path module and half a text module.** `readJsonc` takes a path and does its own IO while `appendToJsoncArray` takes text, so `installHooks` reads each config a second time and re-implements the absent-file rule the reader already encodes. Every future writer — removing a hook, editing the Codex config — repeats the exists, read, append, check, back up, write sequence. Either the module grows a path-level edit and `hooks.ts` keeps only the backup policy, or the reader drops its IO and callers pass text.

- **Two small edit infidelities.** A comment trailing the last element of an array ends up labeling the entry appended after it, because the insertion point is the end of the previous element and not the end of its line. And an edited object in a CRLF file comes back with LF line endings. Both are `jsonc-parser` behaviors rather than mistakes here, neither loses a value, and neither has a caller complaining yet.

- **Each `dim` subcommand carries its own help.** Queries already do — `q list` prints from the registry — while `src/cli.ts` holds a written-out usage string beside its switch, so adding a command is two edits and a missed one is silent. The reader is an agent that takes the printed surface as the whole surface, so a flag absent from the listing does not exist to it. The shape is in [`landscape.md`](landscape.md)'s borrow table, including what not to take from it.

- **A slice cannot commit unchecked.** Argued by 2026-09-18, when a lane bypassed the gate with `DIM_SKIP_CHECK=1` where nothing refused it and only `q slices` said so afterward. A `pre-commit` hook knows the repo it runs in and not which slice it is looking at, so what makes a check countable has to be settled before a gate can hold it. Until it exists, whether a slice was checked is a question only watching answers. The read-only half of this pair is held: [`dim-station-build`](../skills/dim-station-build/SKILL.md) and [`dim-station-review`](../skills/dim-station-review/SKILL.md) both launch their agents without write tools, after a checker reverted a builder's fix on the same day.

- **`q repeats` classifies meaning with a word list.** A stopword set decides which phrases are filler, a regex decides what nobody said, and 400 characters decides sentence from document. [`findings.md`](findings.md) already measured it missing the one correction repeated six times across 29 sessions, so the replacement is meaning rather than a better list — which waits on `correction_label` having rows.

- **Three sample cutoffs no test can prove.** `files_touched >= 20` in `rework`, `files >= 20` in `fixes`, `edits >= 3` in `exemplars`. Each silently decides which skills are worth reporting on. A constant whose correctness no test can prove is the tell for a cause still untouched; what replaces it is the query stating the base it kept and the reader judging, which is the rule the rest of the queries already follow.

- **A stuck-slice counter.** A slice that keeps failing the repo's check and being re-attempted is invisible to the loop today. Ferment blocks a step after three starts without a completion ([`landscape.md`](landscape.md)); the record here spans sessions, so it can see a slice retried once per session across four, which a per-run state file cannot. The factory driver bounds itself instead, stopping on the second failure of one item inside a run and seeing nothing across runs.

- **The arm that says whether checking pays.** `finding` holds the rows and `q findings` reads them by dimension, so what is left is the join nobody can run yet: a finding's file against the later `fix:` commits that came back to it, slices checked against slices that were not. It waits on rows rather than on code, and building the comparison before there are rows produces the empty table the rejected-changes ledger was turned down for.

- **A judge for a refused finding, as a step rather than a sentence.** [`dim-station-build`](../skills/dim-station-build/SKILL.md) says to settle a disputed finding with a third agent, and nothing makes that happen: the builder decides whether to reach for it, under the one bias the step exists to correct. The trigger is stated there — a refusal resting on whether a finding is true rather than on whether it matters. What is unbuilt is anything that makes it fire, and a record of how each went, without which nothing says whether the judge ever changed an answer.

- **Two label counts state a base that can include a label whose message is gone.** `correction_label` carries no foreign key, so a label outlives a message whose transcript left the disk. The per-skill column in [`src/queries.ts`](../src/queries.ts) joins `message` and drops such a row, while the two scalars beside it count the table bare, so the denominator can exceed the column it introduces with nothing saying why. Which is right is the decision: join `message` in both and count only labels that still reach one, or keep the bare count and have `rebuild` report the labels whose message did not come back.

- **`q keywords` ANDs every word, so a question rarely matches.** Asked "benchmark recall known relevant questions ranking" on 2026-09-17, it returned nothing while the subject was sitting in the record. Every term is required, so a natural-language question of six words needs all six in one message. The door was built for questions and answers best to two or three words, which is not what anyone will type. What to do is the decision: rank by how many terms matched rather than requiring all, or say plainly in the query's own output that it wants few words.

- **Whether the simplification pass in `dim-station-build` pays.** The step is built and every slice now carries it, so it spends on each one; nothing measures what it returns. What would answer it is an arm — slices run with the pass against slices run without — scored by whether a later fix commit came back to what each touched, which is the join `q fixes` reads by skill and would have to read by arm. Until then the step rests on the owner's own practice, which is a reason to build it and not a measurement.

- **The aimed simplification pass**, which is the different question: which code that no slice just touched has earned one, read off `q fixes`, `q rework` and `q exemplars` rather than off whatever is open. This is where the measurement in [`findings.md`](findings.md) applies. Two pieces follow rather than block it: the unmodified-tests rule as a hook, and a catalog of smells as one agent per smell with a fixed brief, of which only file length, parameter count and duplicate blocks are shapes a gate can hold.

- **Why files edited under `agents-md` draw four times more fixes afterward than before** ([`findings.md`](findings.md)), on the largest station sample measured. Nothing explains it, and it is the shape every other station was checked for and cleared of.

- **The generated conventions block** ([`conventions.md`](conventions.md)), which that writer is the precondition for. Its first condition is now met — three gates exist and `doctor` reports a hook that is missing, stale or in a directory git does not read, and a checkout where the push gate cannot fire — and its second is not: `loop.md` requires each cut recorded as characters removed against the calls they would have stayed resident for, and the three rules cut from `~/.claude/CLAUDE.md` on 2026-09-17 were cut by hand and never measured. Do that measurement before generating anything.
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
