# Factory workflow

The factory moves an order from evidence-backed research to a shipped result while preserving the intent, structure, execution, review, and outcome needed to improve the next order.

## Order lifecycle

The stations form one path, but an order also has queue, worker, environment, integration, and stopping state. Each station worker writes a different artifact. The plan explains what should be true; the implementation outline explains how this repository will make it true; the slices and evidence show what happened.

Every human-facing artifact leads with a concise outcome for the reader and scales its supporting detail to the change's size and risk. A small fix stays short; a multi-boundary change exposes the program design and its dependencies. Scaling the explanation never removes a required contract, evidence, or attribution field. This applies to plans, Build artifacts, reviews, and execution reports.

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
| **Core order loop** | Queue, claim, plan, delegate verified slices, review, produce a Build artifact, ship, complete | The durable order, plan, slice, check, finding, artifact, commit, and outcome records; no blocking human gate |
| **Targeted planning** | The core loop plus independent read-only planning workers | Prior-art, contract, program-design, or risk workers for unfamiliar, multi-file, boundary, or irreversible work |
| **Plan comparison** | Targeted planning plus plan revisions and implementation comparison | Call and dependency graphs, attempt identities, loop iterations, owner verdicts, and plan-versus-result queries |
| **Self-maintaining factory** | Plan comparison plus scheduled reviews and measured process changes | Architecture, test, docs, security, dependency, and simplification sweeps for projects and the factory itself, whose findings become ordinary orders |

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

**Live.** A claim creates or reuses the order worktree, records the worker, operator attribution, station, branch, and run identity, and moves the order to working. The append-only attempt ledger records a `started` row for every claim and a `finished` row when that station hands the order onward or records failure. Its outcomes are `running`, `succeeded`, and `failed`; order status remains the queue projection. A runner records failure only while its own run is active, so delayed process output cannot add a second failure after a slice has completed. Claims and integration are serialized; independent orders may run in parallel.

An order's branch stays on the trunk it was cut from while its stations run; the one rebase is at ship, onto the trunk as it then stands ([`factory.md`](factory.md#done)). It is recorded as each commit's previous and rewritten identity, because a rebase changes commit shas, and every later check and review reads the rewritten head. A rebase that changed a patch returns the order to review, and the round after it reads the whole order from the new base. A rebase that stops on a conflict returns the order to build with its worktree left mid-rebase: the builder resolves the conflicting paths, the runner continues the rebase and re-checks it rather than committing the turn, and the order then goes to review for the whole order, since part of what lands is the builder's resolution.

The repository owns setup and teardown details: dependencies, services, ports, environment files, and health checks. Dim owns the worktree lifecycle and records the setup and teardown reports. A setup failure holds the order before implementation rather than allowing a worker to produce misleading evidence.

Every worker act names its worker at write time. A runner failure before a worker bootstraps carries no worker and keeps its harness evidence instead of borrowing the operator's identity. Harness identity, model, tier, and operator are recorded as attributes of the run or event rather than inferred later from a transcript join.

When the operator records recovery after a runner has already claimed a worker, the lifecycle event names the operator who performed the recovery while the finished attempt remains attributed to the worker that ran it. The attempt records the operator who delegated that run. A worker's parent records who first spawned it and does not restrict a later operator from reusing it. The two acts stay distinct in the audit trail.

## Delegation and worker trees

The operator owns one project run, while each station owns the shape of its internal delegation. A station worker may request child workers for independent work; the factory creates a one-use assignment, and the child harness bootstraps it under its own session before the factory creates the worker and records the parent-child relationship. The station chooses the dimensions, and the operator does not repeat that knowledge by spawning each child manually.

```text
operator
  → station worker
      → child workers
```

The station coordinator receives the children’s evidence and returns one station result to the operator. A coordinator may request `spawn-workers`; a child worker does not receive that capability. Every request, spawn, result, and finding names the worker that performed it. Worker registration records the direct parent; request, result, and finding records remain part of the station slices that use this tree.

## Research

**Live.** The planning station starts with the machine's record rather than a blank page. It asks:

- `dim q prior-art` — where this shape already exists on disk
- `dim q search` — what was previously settled
- `dim q chain` and `dim q resume` — whether this continues earlier work
- `dim q stale` — whether earlier conclusions need to be reread

The research artifact records the queries, the relevant references, the conclusions they support, and what each conclusion removed from the work. An empty result is evidence that the shape is new.

## Design and plan

**The first executable process delegates planning to a planner worker.** The planner writes the plan under its own name. Only the operator may invoke planning or review delegation; the command boundary refuses those actions from station workers. The operator checks that the plan answers the order, then records its decision before delegating implementation. This approval authorizes execution; it is not an independent quality review. Planner fan-out, synthesis, and independent plan review remain later additions after the core order loop works.

A plan contains:

- **Outcome.** What becomes true, the boundary of the change, and explicit non-goals.
- **Evidence.** Prior art, existing decisions, project conventions, and unresolved gaps.
- **Contracts.** Types, schemas, closed vocabularies, invariants, errors, and ownership of responsibilities.
- **Executable contract checks.** Where a boundary can be exercised, the contract includes a focused check or fixture for the consumer's expectations and the provider's response. Prose records the decision; the check protects it during implementation.
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

An order may contain multiple slices. The factory processes them sequentially, reusing the order's planner, builder and reviewer identities while giving each slice its own commit, check, simplification pass, review and findings loop. The owner approves the build once, after the final slice and the single Build artifact are complete.

## Build

**The factory target.** The build station is a meta-skill that assigns one builder to an order and reuses that worker across its slices while the operator observes the order through the wall. The builder receives the operator-approved ordered slice outline as part of its brief. This removes the owner from the implementation path without turning the first version into a parallel worker swarm. Slices run sequentially, and the factory advances through intermediate build and review rounds without an owner gate. The owner gate opens once the final slice and the single Build artifact are complete.

### Default slice order

When a slice has persisted state and a consuming surface, its default dependency order is authoritative contracts and state, the provider path, asynchronous effects or agent integration, then the consumer surface. In practice that means:

```text
contract and data model
  → schema, migration, lifecycle and ownership
  → repository, service and API path
  → jobs or agent dispatch
  → UI, mobile, widget or other consumer
  → end-to-end check
```

This is a dependency order, not a rule to complete one technical layer across the whole feature. Tests, documentation and boundary checks accompany each step, and a slice still closes one usable path before the next slice begins. A repository without persisted state starts at its own authoritative contract rather than inventing a database layer.

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

An order with multiple slices repeats this loop for each slice before starting the next one. The same order identities continue across the slices, and the record makes each slice's commit, check, review and approval measurable.

The next slice is derived from the approved plan: it is the first ordered slice without a completion record. Completing a slice records the slice, worker and time in the append-only order record. A failed or interrupted turn leaves that slice incomplete, so the same builder returns to it; a later plan revision has new slice records and starts at its own first slice. There is no separate mutable cursor.

The owner does not need to watch the worker's session directly. The wall shows the order's station, worker, silence, holds, failed checks, and current owner action; the order dialog shows Plan, Build and Review sections throughout the order, their reports when recorded, execution summary, audit log, changes, and bounded program graph. An empty section says when that station has not completed its work. The operator handles routine delegation and phase decisions; the owner enters at holds, repeated failures, architectural risk, ship, and verdict.

The operator works above the stations. Every station follows the same contract:

```text
operator states the outcome and constraints
  → station worker performs its responsibility
  → worker returns an attributed artifact and evidence
  → operator checks the result against the request
  → operator advances, returns, or holds the order
```

The artifact changes by station — a plan, one Build artifact for the completed order, or a review — but the control boundary does not. Intermediate build slices return commits and checks for the operator to inspect before review; the final build also returns its owner-facing artifact. For every station, `dim order approve <order-id>` approves the current artifact, while `dim order return <order-id> --reason "..."` sends it back to the same worker with feedback. The return and each new artifact revision are attributed in the event record; earlier revisions remain unchanged. Simplification is part of the build station's loop, not a separate station or worker role. The operator delegates planning, building, and review; it does not re-review implementation or substitute for an independent reviewer. Because it owns the original request and the delegation contract, it checks each returned outcome against the record before moving the order forward.

Before tasking review, the operator checks the builder's exact latest commit and passing check. The review command refuses to spawn without that evidence, so a clean process cannot mistake a builder's successful exit for an outcome the operator has checked. A later commit replaces the review target. The owner approves the final Build artifact before review, then approves the clean Review artifact before shipping.

After a review closes, the operator approves that exact Review artifact before the order can move to ship. Approval requires a clean closed review with no findings; an aborted review or a review that raised findings returns the order to the builder loop. The ship move requires the approval and the operator's identity, so a worker cannot advance its own outcome.

The build record also carries the worker, slice, and attempt identities needed to count loops honestly. A loop is not inferred from elapsed time or from the number of messages; it is a recorded iteration containing its start, end, slice, check or review result, worker, and outcome. Delegated and owner-driven builds remain distinguishable so the factory can compare owner attention, implementation time, loops, findings, and later `fix:` commits.

Long-running work may cross context windows. A context reset starts a fresh worker with a structured handoff containing the approved plan revision, current slice, committed state, checks, findings, decisions, and next action. Compaction may shorten a session, but it is not the recovery contract; the handoff is the durable state the next worker can verify.

## Review

**Live.** Review reads the diff against the approved plan, which its brief carries, and uses the record to aim its dimensions. Plan conformance, correctness, tests, architecture, maintainability, docs, security, and style are separate read-only passes; performance is added when the plan identifies a performance-sensitive path. The reviewer returns a structured report rather than prose, and the factory refuses one whose finding lacks a file the diff changed, a line that file has at head, the failure, a fix direction or a blocking severity. From round two on, the brief lists each open earlier finding the builder has answered, with that answer, and the report rules on every one. The factory renders the owner's Review artifact from the report and the record ([`src/review-report.ts`](../src/review-report.ts)). Each finding is checked at its source and then fixed or refused with a reason.

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

Reviews have two scopes. A `slice` review reads one slice's exact commit range against its brief and runs before the next slice starts. An `order` review reads the assembled range against the approved plan and outcome and runs after the final slice. The same review station and order reviewer identity handle both scopes; a one-slice order needs only its slice review.

The order report reports the review coverage, unresolved review debt, cross-module edges, and the time between implementation and review. A later project-wide review is a scheduled diagnostic or a bounded repair order, not the normal way to discover whether shipped work was sound.

Review compares three graphs:

```text
planned call/dependency graph
  ↔ implemented source graph
  ↔ observed lifecycle and tool-event graph
```

The review result records findings and answers, not a score for the builder. A later fix commit is evidence that the changed files needed attention, but it is not by itself proof that the original agent caused the defect.

### Evaluation discipline

An evaluator receives a fixed brief and explicit criteria before it reads the result. The builder cannot evaluate its own work as the only review, and a reviewer has no mutation tools. The evaluator returns findings and evidence; it does not edit the order or convert uncertainty into a passing score. Subjective criteria are calibrated against accepted examples and rechecked when the model, prompt, or review skill changes.

The factory chooses the cheapest reliable sensor for each question. Repository checks, schema validation, structural tests, dependency scans, and architecture rules run mechanically and as early as practical. Semantic review, broad architecture review, mutation testing, and other expensive evaluators run at the slice, integration, or scheduled-project level when their evidence justifies the cost. A green evaluator result is evidence about the tested question, not a certificate that the whole project is correct.

## Ship

**Live in part; the explanation gate, owner verdict, and separate integration evidence are planned.** The history repeatedly converges on a plan-before/Build-artifact-after pair, and prior project workflows use an explicit ship/change/rethink verdict. The order therefore produces an independent artifact of what was built before shipping.

The Build artifact is similar to the `explain-diff` skill, but is scoped to the order. A fresh worker reads the approved plan, implementation outline, commits, changed files, program graph, checks, and review findings. The builder's artifact leads with the outcome, then explains the meaningful implementation, why it has this shape, what verification establishes, and what the owner should scrutinize. It groups the explanation by logical change, not by file or slice, and leaves command output, exhaustive file lists, slice history, and unrelated failures in the audit record. It explains; it does not review or approve.

When a human shipping gate is enabled, it reads:

```text
approved plan
  ↔ Build artifact
  ↔ independent review artifacts
  ↔ mechanical checks and integration evidence
```

The owner can then choose to ship as planned, return for changes, ship with an explicit deviation, or hold for a deeper decision. This is the intended human gate for a later phase, not a requirement of the first version.

The owner verdict records whether the result landed as planned, was sent back, or changed before landing, with grounds for any decision other than acceptance as planned.

In the first version, the operator ships when the mechanical completion conditions and independent review conditions pass. The Build artifact is recorded for observability and later evaluation; it does not block shipping and does not imply owner approval. A later phase can make it a gate after measuring whether it reduces missed scope, plan deviations, and later fixes. Shipping still verifies the order's checks and evidence, confirms the change reached the intended trunk or delivery boundary, and leaves the order's terminal outcome. Which boundary that is comes from the repository's own declared ship method, never from the operator's judgement ([`factory.md`](factory.md#done)). Completion and integration are separate facts: verified work can exist before it is integrated. The Build artifact is not a replacement for tests or review, and a clean worker exit is not evidence of delivery.

## Completion and cleanup

**Live in part.** An order is complete only when the final check vouches for the final recorded commit, every finding has a fix or a stated refusal, required documentation changed with the behavior, the recorded commit is reachable from the intended trunk, and the worktree can be removed successfully.

Shipping precedes completion, and completion precedes worktree removal. The integration event is separate from the completed outcome so the record can distinguish verified work from work that actually reached trunk or another delivery boundary.

If the order cannot complete, it stops explicitly as held, blocked, or failed. A failed attempt becomes eligible for bounded retake; a repeated failure stops the order for owner attention. A dropped order is the owner's decision not to build queued work and is not treated as an unsuccessful implementation attempt.

## Scheduling and maintenance

**Planned.** A host such as launchd, cron, or Codex only invokes Dim. Dim owns schedule definitions, due evaluation, selected orders, invocation outcomes, and holds. Scheduled reviews are read-only passes over a risk-relevant project or boundary; their findings become bounded orders, holds, or refusals rather than direct mutations.

Maintenance has two sensor classes. Change sensors run inside the order lifecycle and give the worker feedback before commit or integration. Health sensors run outside an order against accumulated project or factory state: architectural drift, dead code, test quality, dependency exposure, documentation drift, review debt, runtime signals, and factory-process regressions. A scheduled review selects sensors from the risk and history of the project rather than running every sensor on every cadence.

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

The factory also reviews itself. Changes to skills, prompts, routing, evaluator criteria, schemas, or orchestration are run against representative workflow cases and compared with the previous behavior. A factory change is released only with evidence of what improved, what regressed, and what remains unknown.

```text
project or factory signal
  → read-only diagnostic
  → diagnosis with evidence
  → bounded prescription
  → ordinary order
  → measured outcome
```

Maintenance must not manufacture queue noise. A repeated finding carries its fingerprint and prior attempts, duplicate findings are grouped, and an automated repair has a bounded failure budget. A diagnostic that cannot justify an order remains a recorded observation rather than a speculative change.

## Human gates

The evidence supports human attention at boundaries where the system cannot establish correctness from the repository and its record alone. The goal is not to keep a person in every station; it is to spend attention where a wrong decision is still cheap to change and where automation would otherwise confuse a clean execution with a correct outcome.

| Gate | Keep the owner when | Automate when | Evidence to record |
|---|---|---|---|
| **Plan approval** | The change is hard to reverse, outward-facing, machine-wide, or changes the project's direction | The planner can proceed under settled conventions and the order explicitly waives approval | Plan revision, operator, decision, grounds, time to approval |
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
