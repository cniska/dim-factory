# The factory

The argument this repo exists to execute. It is a position to argue with, not a description of what is built — what is built is in [`README.md`](../README.md), and what it is measured against is in [`goals.md`](goals.md).

## The line already exists

The owner's tool-agnostic engineering skills form a production line — spec, plan, build, review, ship — and the parts map onto a factory more cleanly than they were designed to.

- **Skills are the stations.** Each is a repeatable operation with an entry contract and an exit check.
- **A coding agent is the floor.** It executes stations with tools, budgets and a lifecycle, and the driving is handed to the model rather than scripted.
- **`AGENTS.md` and `SPEC.md` are the fixtures and tolerances.** Per-project grounding, and a machine-checkable statement of what correct means. A line cannot run unattended without them.
- **Review, verify and the gates are QC.** They pass or fail work without a human reading every diff.

None of it was built to be a factory. It became one because each phase was made repeatable and verifiable on its own terms.

## What is missing is not another skill

Two layers separate a set of stations from a line that runs itself, and neither is more instruction.

1. **Someone to start the work.** A factory runs when work begins without a person starting each task. The queues already exist — a file, a tracker, a list of issues — so what the stations lack is not a place for work to wait but something that reads one and opens the job. `dim-factory` does that: it takes a queue rather than keeping one, so a file it is handed, a tracker the repo declares and what it finds by looking all reach the same reader; it picks an item, routes it to the station whose shape fits, and holds the run inside the bounds below rather than judging them. For this repo the queue is [`build-order.md`](build-order.md).
2. **Verification worth leaving.** A gate becomes autonomous when its check is strong enough to remove the human standing at it. The checks catch regressions and broken contracts. They do not catch a coherent, confident, wrong design, so a human stays at that gate — not as ceremony, but because the check is incomplete.

## Why the answer is not dark

The moment a human reads the work is where a wrong decision becomes visible while it is still cheap to change. Removing every such moment removes that, so running lights-out is not a missing feature but a choice against a principle.

The honest question is therefore not whether the line can run itself. It is **at which gates removing the human costs more than it saves** — a question with a different answer per gate, and a different answer next year than this one.

## Dim, not dark

- **Autonomous between the gates.** Once a direction is agreed the agent drives: reads, writes, verifies, recovers, without asking at every branch.
- **A human at the gates that matter.** High-risk, irreversible or ambiguous changes pause for judgement, the same instinct as a confirmation before a release.
- **Each gate earns its automation on its own merit**, reversibly, as verification gets strong enough to catch design-level errors — never by fiat and never all at once.

That is an autonomous cell rather than a factory: a bounded unit that runs work end to end with a person at its edges. It is the version that does not require pretending the checks are more complete than they are.

## What follows from it

Merit means evidence, which is why this repo collects any. [`goals.md`](goals.md) states what the factory is measured against and in what order. [`findings.md`](findings.md) is what the corpus said when it was first asked. [`loop.md`](loop.md) is how a rule that stopped earning its place gets cut, and [`evals-and-hooks.md`](evals-and-hooks.md) is the instrument that decides whether it was earning one.
