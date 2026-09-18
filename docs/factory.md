# The factory

The argument this repo exists to execute. It is a position to argue with, not a description of what is built — what is built is in [`README.md`](../README.md), and what it is measured against is in [`goals.md`](goals.md).

## The line already exists

The owner's tool-agnostic engineering skills form a production line — spec, plan, build, review, ship — and the parts map onto a factory more cleanly than they were designed to.

- **Skills form the line and stations.** `dim-feat` and `dim-fix` are line entry points; `dim-plan`, `dim-build` and `dim-review` are repeatable stations with entry contracts and exit checks.
- **A coding agent is the floor.** It executes stations with tools, budgets and a lifecycle, and the driving is handed to the model rather than scripted.
- **`AGENTS.md` and `SPEC.md` are the fixtures and tolerances.** Per-project grounding, and a machine-checkable statement of what correct means. A line cannot run unattended without them.
- **Review, verify and the gates are QC.** They pass or fail work without a human reading every diff.

None of it was built to be a factory. It became one because each phase was made repeatable and verifiable on its own terms.

## The lane contract is planned

The planned factory assigns each queue item to one self-sufficient lane that runs it to a verifiable stopping point.

- **Ownership.** One lane owns one queue item end to end, in an isolated worktree.
- **Delegation.** The lane may delegate internal triage, implementation slices, simplification and checking, while retaining responsibility for the item and its evidence.
- **Completion.** The lane runs until the item is complete, it reaches an explicit fence, or it reaches its failure limit.
- **Parallelism.** Independent lanes may run in parallel in isolated worktrees. Claims, landing and queue-state transitions remain serialized.
- **Driver.** The factory driver schedules lanes, observes their evidence and integrates completed work. It does not implement the item.
- **Count.** An explicit item count limits a run; the default count is one. The factory does not drain the queue implicitly.

The lane returns a delivered-product report containing the item and queue identity, station and delegation tree, worktree and branch, changed files, commit SHA, repo check and result, checker findings and resolutions, updated docs, and final status: complete, blocked, fenced or failed. A complete or stopped report includes the evidence the driver needs to land the work or stop at the stated boundary.

## Report persistence is planned

The delivered-product report will be persisted in the dim database so it remains queryable after the session rather than existing only in chat. Its planned record includes:

- **Identity.** Queue and item identity, lane and run identity, agent identity, worktree and branch.
- **Work.** Station, delegation tree, changed files and commit SHA.
- **Verification.** Repository check command and result, checker findings and their resolutions, and updated docs.
- **Outcome.** Final status — complete, blocked, fenced or failed — with fence or blocker evidence and timestamps for the lifecycle events.

The report lifecycle is planned as a durable sequence from claim through running to completion or a stopped outcome, with evidence updated as the lane progresses. The current database has no factory report record or factory-report query, so this persistence and lifecycle are not live.

These are planned boundaries, not live guarantees. The current record does not yet persist item claims, lane ownership or queue-state transitions, so the contract cannot safely be treated as implemented.

## What is missing is not another skill

Two layers separate a set of stations from a line that runs itself, and neither is more instruction.

1. **Someone to start the work.** A factory runs when work begins without a person starting each task. The queues already exist — a file, a tracker, a list of issues — so what the stations lack is not a place for work to wait but something that reads one and opens the job. `dim-factory` does that: it takes a queue rather than keeping one, so a file it is handed, a tracker the repo declares and what it finds by looking all reach the same reader; it picks an item, routes it to the station whose shape fits, and holds the run inside the bounds below rather than judging them. For this repo the queue is [`build-order.md`](build-order.md).
   The driver passes the item and base revision to the builder. The builder creates its isolated checkout with `dim wt` before invoking its line or station and owns the work from there.
2. **Verification worth leaving.** A gate becomes autonomous when its check is strong enough to remove the human standing at it. The checks catch regressions and broken contracts. They do not catch a coherent, confident, wrong design, so a human stays at that gate — because the check is incomplete.

## Why the answer is not dark

The moment a human reads the work is where a wrong decision becomes visible while it is still cheap to change. Removing every such moment removes that, so running lights-out is not a missing feature but a choice against a principle.

The honest question is therefore not whether the line can run itself. It is **at which gates removing the human costs more than it saves** — a question with a different answer per gate, and a different answer next year than this one.

## Dim, not dark

- **Autonomous between the gates.** Once a direction is agreed the agent drives: reads, writes, verifies, recovers, without asking at every branch.
- **A human at the gates that matter.** High-risk, irreversible or ambiguous changes pause for judgement, the same instinct as a confirmation before a release.
- **Each gate earns its automation on its own merit**, reversibly, as verification gets strong enough to catch design-level errors — never by fiat and never all at once.

That is an autonomous cell rather than a factory: a bounded unit that runs work end to end with a person at its edges. It is the version that does not require pretending the checks are more complete than they are.

## What the assembly line already settled

Borrowed, and each kept only where a mechanism here carries it. The names are worth keeping because they are searchable, and because each one names a mistake that is easy to make twice.

- **Stop on a defect, never on success** (*jidoka*). A machine that detects an abnormality halts itself rather than passing the part along. The `pre-commit` gate is this: the check fails, git refuses, nothing downstream sees it. The factory driver halts on a second failure of one item and on two failures in a row, and on nothing else — finishing an item is not a reason to stop a line.
- **Anyone may halt the line** (*andon*). A checker's finding stops its slice until the finding is answered, by a fix or by a stated refusal. The same for a finding that keeps recurring is unbuilt; [`build-order.md`](build-order.md) holds it.
- **Fix the process, not the part.** A defect found once is repaired; a defect found repeatedly is a gate that does not exist yet. `dim q findings` counts by dimension, which is what names the candidate. The worked example is a diagnostic written through a console API: the instance was fixed, and then `noConsole` in [`biome.json`](../biome.json) stopped the class being representable.
- **Make the error impossible rather than forbidden** (*poka-yoke*). The argument under "Checks use model judgement, not pattern matching" in [`AGENTS.md`](../AGENTS.md): express as a gate whatever is mechanical, and leave to judgement only what needs it.
- **One piece at a time.** A slice is verified and committed before the next begins. A branch of unverified slices is one slice with a long diff, which is a batch waiting to be reworked.
- **Go and see** (*genchi genbutsu*). Verify a claim at its source rather than from a plausible reading of it. A number quoted without being measured is what this is against, and [`findings.md`](findings.md) holds a case of it.
- **The operator does not work the line.** Whoever runs the queue hands each item to a builder and watches what the line does — what is stuck, what fails twice, whether the gates still hold. Hands in one diff is attention off every other station.

What does not transfer is takt time. Pacing output to demand assumes interchangeable units, and a slice is not one; a cadence would manufacture work to fill it, which [`loop.md`](loop.md) rejects for the same reason it rejects a scheduled sweep.

## What follows from it

Merit means evidence, which is why this repo collects any. [`goals.md`](goals.md) states what the factory is measured against and in what order. [`findings.md`](findings.md) is what the corpus said when it was first asked. [`loop.md`](loop.md) is how a rule that stopped earning its place gets cut, and [`evals-and-hooks.md`](evals-and-hooks.md) is the instrument that decides whether it was earning one.
