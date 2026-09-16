# The dark factory

> Exploration, not a roadmap. This captures a framing from a session, not a commitment or a schedule. It sits behind the v1 bar in `plan.md` and builds on the durability reasoning in `remote-execution.md`. Read it as a direction to argue with, not a description of what exists.

## Thesis

The engineering skills already form a production line: `spec → plan → build → review → ship`, each stage with a defined input, a defined output, and a check that passes or fails it. Acolyte is the floor that can run those stages. So the interesting question is not whether the machinery for an autonomous software factory exists — most of it does — but whether to run it lights-out. My own methodology answers no, and that answer is the point. The target is not a dark factory. It is a dim one: autonomous between the gates, a human at the gates that matter.

## The line already exists

The parts map onto a factory more cleanly than they were designed to.

- Skills are the stations. Each one — spec, plan, build, review, ship — is a repeatable operation with an entry contract and an exit check.
- Acolyte is the floor. A runtime that executes stations with tools, budgets, and a lifecycle, and hands the driving to the model rather than scripting it.
- `AGENTS.md` and `SPEC.md` are the fixtures and tolerances. Per-project grounding, and a machine-checkable contract for what "correct" means. A line cannot run unattended without them.
- Review, `dogfood`, and verify are QC. Gates that pass or fail work without a human reading every diff.

None of this was built to be a factory. It became one because each phase was made repeatable and verifiable on its own terms.

## What is missing is not skills

Two layers stand between this and an autonomous line, and neither is another skill.

1. Intake. A factory runs when work arrives without a human starting each task — an issue, a queue, a scheduled sweep. The line exists; the conveyor feeding it does not. This is where `remote-execution.md` matters: moving ownership of a unit of work up from the connection to the session or user, and making its state durable, is the substrate intake needs. Work has to outlive the thing that started it before it can start itself. The durable-state half of that substrate already ships: cloud sync runs in two forms — the OSS self-hostable `acolyte-cloud` and the managed, paid `app.acolyte.sh` (live; `acolyte login` works end to end), deliberately thin. State can outlive a machine today. That is the foundation, not the conveyor; nothing yet triggers work on its own.
2. Verification you trust enough to leave. A gate only becomes autonomous when its check is strong enough to remove the human standing at it. Today the checks catch regressions and contract breaks; they do not yet catch a coherent, confident, wrong design. Until they do, a human stays at that gate — not as ceremony, but because the check is incomplete.

## The tension with our own stance

`unsupervised-work` and `my-workflow` argue that the human-in-the-loop is where quality comes from — that removing the review moment removes the place where a wrong decision becomes visible while it is still cheap to change. A dark factory is the direct negation of that. Running lights-out would mean abandoning a position taken deliberately and defended in writing.

So "dark" is not a missing feature. It is a choice against a principle. The honest question is not "can the line run itself" but "at which gates does removing the human cost more than it saves."

## Dim, not dark

The defensible target keeps the lights on exactly where the methodology says they must be:

- Autonomous execution between gates. Once a direction is agreed, the model drives — reads, writes, verifies, recovers — without asking at every branch. This is already how the host is built: support the model, do not constrain it.
- A human at the gates that matter. High-risk, irreversible, or ambiguous changes pause for judgment. This is not a fallback; it is the same instinct as the `ship` skill's confirmation before a release and the `plan` skill's collaborative design before code.
- The gates earn their automation over time. As verification gets strong enough to catch design-level errors, individual gates go dark on their own merit — not by fiat, and reversibly.

That is an autonomous cell, not a factory: a bounded unit that runs work end to end with a person at its edges. It is the version consistent with everything already written, and it is a better target than lights-out because it does not require pretending the checks are more complete than they are.

## Connections

- [plan.md](plan.md) — the v1 bar this sits behind.
- [remote-execution.md](remote-execution.md) — durability and ownership-up: the substrate the intake layer needs.
- [positioning.md](positioning.md) — why autonomy is the edge that compounds, not a feature.
- `handoff` as a native command (planned) — a session handing its own state forward across a context reset: the same continuity move as durable work, one gate closer to work that starts itself.
- The engineering skills (`cniska/skills`) — the stations, and the SDLC line they form.
