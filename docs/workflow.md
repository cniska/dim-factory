# Factory workflow

The factory moves an order from evidence-backed research to a shipped result while preserving the intent, structure, execution, review, and outcome needed to improve the next order.

## Order lifecycle

The stations form one path, but an order also has queue, worker, environment, integration, and stopping state. Each station produces a different artifact. The plan explains what should be true; the implementation outline explains how this repository will make it true; the slices and evidence show what happened.

```text
intake
  → preflight
  → claim and isolate
research
  → design and plan
  → program design
  → implementation outline
  → build verified slices
  → review
  → ship
  → complete and clean up
```

An order may stop at a hold, a failure limit, or a factory stop between any stations. The owner decides hard-to-reverse, outward-facing, or machine-wide choices; the factory settles ordinary implementation choices from the repository, its rules, and the record.

## Phased adoption

The factory starts with the smallest complete lifecycle and adds planning machinery only when the record shows that the missing information causes waste or risk. Every phase must remain a useful workflow on its own.

| Phase | Workflow | Adds when needed |
|---|---|---|
| **Core order loop** | Queue, claim, plan, delegate verified slices, review, produce an account, ship, complete | The durable order, plan, slice, check, finding, account, commit, and outcome records; no blocking human gate |
| **Targeted planning** | The core loop plus independent read-only planning workers | Prior-art, contract, program-design, or risk workers for unfamiliar, multi-file, boundary, or irreversible work |
| **Plan comparison** | Targeted planning plus plan revisions and implementation comparison | Call and dependency graphs, attempt identities, loop iterations, owner verdicts, and plan-versus-result queries |
| **Self-maintaining factory** | Plan comparison plus scheduled reviews and measured process changes | Architecture, test, docs, security, dependency, and simplification sweeps whose findings become ordinary orders |

The meta-station shape is stable across the phases, but participation is conditional. A small local change can use one planner and one reviewer. A schema or boundary change can fan out to contract, program-design, and risk workers. The planner still synthesizes one authoritative plan, regardless of how many workers contributed. Build delegation is part of the core factory shape; parallel slices are not.

The factory must not require graphs, predictions, multiple planning workers, or scheduled reviews before they answer a demonstrated question. Their usefulness is measured by the outcomes they make explainable: owner attention, plan revisions, implementation duration, loop count, review findings, and later fixes.

## Intake and preflight

**Live.** Work enters as a queue order with a stable identity, project, title, description, priority, and optional hold. The operator reads ready work, selects a bounded number of independent orders, and routes each to the station that fits its shape. It does not drain the queue implicitly.

Before claiming work, the operator checks the floor and the order:

- factory stops and active holds
- current session-hook contract and worker attribution
- repository check and format commands
- project rules and workspace contract
- prior attempts, current station, and stale handoffs

The operator is responsible for starting and observing the order. It does not implement the change. The worker owns the work inside the order, while the owner remains the human decision-maker.

## Claim, isolation, and environment

**Live in part; durable attempt history is planned.** A claim creates or reuses the order worktree, records the worker, operator/session attribution, station, branch, and attempt identity, and moves the order to working. Claims and integration are serialized; independent orders may run in parallel.

The repository owns setup and teardown details: dependencies, services, ports, environment files, and health checks. Dim owns the worktree lifecycle and records the setup and teardown reports. A setup failure holds the order before implementation rather than allowing a worker to produce misleading evidence.

Every meaningful act names its worker at write time. Harness identity, model, tier, and operator are recorded as attributes of the run or event rather than inferred later from a transcript join.

## Research

**Live.** The planning station starts with the machine's record rather than a blank page. It asks:

- `dim q prior-art` — where this shape already exists on disk
- `dim q search` — what was previously settled
- `dim q chain` and `dim q resume` — whether this continues earlier work
- `dim q stale` — whether earlier conclusions need to be reread

The research artifact records the queries, the relevant references, the conclusions they support, and what each conclusion removed from the work. An empty result is evidence that the shape is new.

## Design and plan

**Live as a station; durable order artifacts are planned.** The planner writes its plan under its own name, and the owner's release is recorded as its own act — a plan carrying the name of whoever transcribed it says that hand planned it. A revised plan is a new version linked to the version it replaces; the previous version remains readable.

A plan contains:

- **Outcome.** What becomes true, the boundary of the change, and explicit non-goals.
- **Evidence.** Prior art, existing decisions, project conventions, and unresolved gaps.
- **Contracts.** Types, schemas, closed vocabularies, invariants, errors, and ownership of responsibilities.
- **Slices.** Independently verifiable vertical cuts, each with a behavior, boundary, affected area, and check.
- **Risks and holds.** Choices that need the owner or conditions that must be true before building.
- **Predictions.** Expected slice count, review dimensions, checks, and whether approval is required. These are compared with the result; they are not promises of duration.

The plan is checked by a reader who did not write it. The reviewer asks whether each slice stands alone, uses the repository's own check, reflects the research, and avoids escalating questions a query could answer.

### Contract review before build

Contract review happens before implementation starts. The independent contract worker checks the inputs, outputs, lifecycle states, transitions, event and attribution shapes, module ownership, error vocabulary, and worker communication formats. It also identifies which fields are authoritative. The builder may refine private implementation details while working, but it does not invent a protocol from heuristics or prose.

The contract check is a first-version build condition, not a human gate. A failed check holds delegation until the contract is clarified or revised. Later review verifies that the implementation honors the accepted contract and records any deliberate revision as a new plan version.

Planning has the same meta-station shape as review, with different dimensions. The workers are independent, read-only, and given fixed briefs; none receives another worker's conclusion. The planner synthesizes their evidence into one plan, and a separate reviewer reads that plan before approval.

```text
planning station
  ├─ prior-art and decision worker
  ├─ contract worker
  ├─ program-design worker
  ├─ risk and boundary worker
  └─ project-convention worker
        ↓
  plan synthesizer
        ↓
  independent plan reviewer
        ↓
  owner approval or hold
```

The workers answer different questions rather than producing competing plans. Their outputs remain attributed evidence attached to the order; the synthesized plan is the single authority that the build follows. This is the planning counterpart to review's correctness, tests, architecture, docs, security, and style dimensions.

## Program design

**Planned as a first-class plan artifact.** Program design makes a multi-file change concrete before implementation:

- **File tree.** Files added, changed, or removed, with one responsibility per file.
- **Key signatures.** The types and functions the slice introduces or changes.
- **Call path.** The entrypoint-to-leaf path through the changed behavior.
- **Data flow.** Where state is validated, transformed, persisted, and projected.
- **Boundary crossings.** Which modules, schemas, queues, hooks, or external effects the change crosses.

The call path is small and readable, not a whole-repository visualization:

```text
command or operator
  → orchestration function
  → domain operation
  → contract validation
  → persistence or external effect
  → event and projection
```

Dim derives bounded call and dependency graphs from the source and records. It compares the planned path with the implemented path to expose unexpected boundary crossings, uncalled planned operations, and writes without corresponding lifecycle events.

## Implementation outline

**Planned as a separate artifact.** The outline translates the approved program design into the repository's conventions: the order of slices, their expected commits, their checks, and the dependencies between them. It does not replace the plan or introduce a second decision authority.

```text
approved plan
  → outline slice 1
  → outline slice 2
  → outline slice N
```

An outline change that alters the approved outcome or contract requires a plan revision rather than a silent rewrite.

## Build

**The factory target.** The build station is a meta-skill that assigns one worker to each slice while the operator observes the order through the wall. This removes the owner from the implementation path without turning the first version into a parallel worker swarm. Slices run sequentially until the record shows that independent slices can be isolated and integrated safely.

Each slice passes through the same loop:

```text
edit
  → repository check
  → simplify
  → repository check
  → read-only reviewer
  → answer every finding
  → repository check
  → commit
```

The slice records its commit, changed files, check, findings, documents, and simplification result. A simplification pass that changes nothing is still an explicit fixpoint. A failed attempt is distinct from the order's queue state and can be retried under a bounded policy.

The owner does not need to watch the worker's session directly. The wall shows the order's station, worker, silence, holds, failed checks, and current owner action; the order dialog shows the plan, result, execution summary, audit log, changes, and bounded program graph. The operator handles routine delegation and stops; the owner enters at plan approval, holds, repeated failures, architectural risk, ship, and verdict.

The build record also carries the worker, slice, and attempt identities needed to count loops honestly. A loop is not inferred from elapsed time or from the number of messages; it is a recorded iteration containing its start, end, slice, check or review result, worker, and outcome. Delegated and owner-driven builds remain distinguishable so the factory can compare owner attention, implementation time, loops, findings, and later `fix:` commits.

## Review

**Live.** Review reads the diff against its intent and uses the record to aim its dimensions. Correctness, tests, architecture, docs, security, and style are separate read-only passes. Each finding is checked at its source and then fixed or refused with a reason.

### Review granularity

The factory reviews changed modules and the boundaries between them while the order is being built. It must not allow review debt to accumulate until the owner has to audit a grown project module by module. Acolyte's history records the cost of that delayed untangle; the factory distributes the same scrutiny across the order's slices instead.

```text
slice changes a module
  → record the affected module
  → review the module in the slice's review passes
  → answer findings
  → commit the slice

slice crosses modules or a boundary
  → record the crossing
  → review the assembled boundary
  → answer findings
  → commit the slice
```

The first version records coverage rather than creating a worker for every module. A review pass names the modules and boundaries it examined; larger or higher-risk orders can fan out into module-specific or boundary-specific workers when the record shows that one pass is missing findings. An order cannot complete with a changed module or introduced boundary absent from the review record.

The order account reports the review coverage, unresolved review debt, cross-module edges, and the time between implementation and review. A later project-wide review is a scheduled diagnostic or a bounded repair order, not the normal way to discover whether shipped work was sound.

Review compares three graphs:

```text
planned call/dependency graph
  ↔ implemented source graph
  ↔ observed lifecycle and tool-event graph
```

The review result records findings and answers, not a score for the builder. A later fix commit is evidence that the changed files needed attention, but it is not by itself proof that the original agent caused the defect.

## Ship

**Live in part; the explanation gate, owner verdict, and separate integration evidence are planned.** The history repeatedly converges on a plan-before/account-after pair, and prior project workflows use an explicit ship/change/rethink verdict. The order therefore produces an independent account of what was built before shipping.

The account is similar to the `explain-diff` skill, but is scoped to the order. A fresh worker reads the approved plan, implementation outline, commits, changed files, program graph, checks, and review findings. It explains the result's intent, load-bearing decisions, risks, non-obvious contracts, plan deviations, and what the owner should scrutinize. It explains; it does not review or approve.

When a human shipping gate is enabled, it reads:

```text
approved plan
  ↔ what-was-built account
  ↔ independent review artifacts
  ↔ mechanical checks and integration evidence
```

The owner can then choose to ship as planned, return for changes, ship with an explicit deviation, or hold for a deeper decision. This is the intended human gate for a later phase, not a requirement of the first version.

The owner verdict records whether the result landed as planned, was sent back, or changed before landing, with grounds for any decision other than acceptance as planned.

In the first version, the operator ships when the mechanical completion conditions and independent review conditions pass. The account is recorded for observability and later evaluation; it does not block shipping and does not imply owner approval. A later phase can make it a gate after measuring whether it reduces missed scope, plan deviations, and later fixes. Shipping still verifies the order's checks and evidence, confirms the change reached the intended trunk or delivery boundary, and leaves the order's terminal outcome. Completion and integration are separate facts: verified work can exist before it is integrated. The account is not a replacement for tests or review, and a clean worker exit is not evidence of delivery.

## Completion and cleanup

**Live in part.** An order is complete only when the final check vouches for the final recorded commit, every finding has a fix or a stated refusal, required documentation changed with the behavior, the recorded commit is reachable from the intended trunk, and the worktree can be removed successfully.

Shipping precedes completion, and completion precedes worktree removal. The integration event is separate from the completed outcome so the record can distinguish verified work from work that actually reached trunk or another delivery boundary.

If the order cannot complete, it stops explicitly as held, blocked, or failed. A failed attempt becomes eligible for bounded retake; a repeated failure stops the order for owner attention. A dropped order is the owner's decision not to build queued work and is not treated as an unsuccessful implementation attempt.

## Scheduling and maintenance

**Planned.** A host such as launchd, cron, or Codex only invokes Dim. Dim owns schedule definitions, due evaluation, selected orders, invocation outcomes, and holds. Scheduled reviews are read-only passes over a risk-relevant project or boundary; their findings become bounded orders, holds, or refusals rather than direct mutations.

Maintenance uses the same lifecycle as feature work:

```text
schedule due
  → select review order
  → inspect project or factory evidence
  → record findings
  → create bounded repair order
  → build, review, ship, measure
```

This keeps tests, architecture, docs, security, dependency, and simplification reviews inside the factory record instead of creating a second maintenance system.

## Human gates

The evidence supports human attention at boundaries where the system cannot establish correctness from the repository and its record alone. The goal is not to keep a person in every station; it is to spend attention where a wrong decision is still cheap to change and where automation would otherwise confuse a clean execution with a correct outcome.

| Gate | Keep the owner when | Automate when | Evidence to record |
|---|---|---|---|
| **Plan approval** | The change is hard to reverse, outward-facing, machine-wide, or changes the project's direction | The planner can proceed under settled conventions and the order explicitly waives approval | Plan revision, approver, decision, grounds, time to approval |
| **Contract and program design** | A schema, boundary, security rule, data model, or public behavior is changing | The change stays inside an established contract and the reviewer finds no boundary drift | Contract revision, program design, call path, owner decision if any |
| **Architecture review** | The change crosses modules, queues, hooks, persistence, or project boundaries | The slice is local and its bounded graph matches the approved design | Graph comparison, findings, fixes or refusals |
| **Hold or repeated failure** | The order lacks a required project contract, exceeds its retry policy, or encounters an ambiguous or unsafe condition | A mechanical gate can state the exact refusal and the next action | Hold reason, failed attempts, release actor, resolution |
| **Ship and owner verdict** | Integration changes trunk, deploys externally, or the result differs from the approved plan | A local verified commit can be integrated under a settled project policy | Integration event, owner verdict, grounds, later outcome |

The evidence does not support human attention for routine queue selection, workspace setup, repository checks, simplification, ordinary finding answers, or event recording. Those have explicit contracts and mechanical evidence. A person watching them would spend attention without adding a decision.

The most valuable gate to instrument first is plan approval. It is upstream of every slice and is where a wrong direction is cheapest to correct. The next is the assembled architecture/program-design review, because a repository check can prove that code runs while not proving that the change belongs in that boundary. Ship and owner verdict are the final gates because a successful agent exit is not evidence that the intended product was delivered.

Gate automation must be earned from verdicts. Record whether the owner accepted the result as planned, returned it, or changed it before landing, then compare attention time, revisions, loops, and later `fix:` commits by gate type. A gate can be relaxed only when its own evidence shows that doing so preserves the outcome it exists to protect.

## What the record can learn

Once plan, revision, slice, attempt, loop, and integration identities are durable, analytics can be derived across every project:

- planning duration and revision count
- implementation duration
- loops and failed checks per slice
- planned versus actual files, functions, and boundary crossings
- review findings and later `fix:` commits
- owner interventions and verdict changes
- outcomes by project, station, operator, worker, model, and plan shape

The derived path is:

```text
immutable events
  → plan, code, call, and outcome projections
  → analytics
  → factory diagnosis
  → proposed process change
  → measured outcome
```

Metrics are never stored as a second authority. Project-specific conventions remain authoritative for checks and structure; the factory supplies the common evidence and lifecycle mechanics. The wall is a read-only projection of this record: it shows queue state, station, worker, holds, silence, evidence, and the next owner decision without becoming another state store.

The wall and order dialog are separate projections of the same lifecycle. The wall shows attention and flow; the dialog shows intent, result, program design, execution summary, audit history, and changes. Neither becomes an analytics dashboard or a second record.

## Design rule

Every station must leave an artifact that the next station can verify, and every graph must be bounded by the order or slice it explains. Intent, implementation, execution, and outcome remain separate so the factory can compare them without confusing a plan with proof that the plan was right.
