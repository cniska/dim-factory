# The factory

The argument this repo exists to execute. It is a position to argue with, not a description of what is built — what is built is in [`README.md`](../README.md), and what it is measured against is in [`goals.md`](goals.md).

## The line already exists

The owner's tool-agnostic engineering skills form a production line — spec, plan, build, review, ship — and the parts map onto a factory more cleanly than they were designed to.

- **Skills form the line and stations.** `dim-line-feat` and `dim-line-fix` are line entry points; `dim-station-plan`, `dim-station-build` and `dim-station-review` are repeatable stations with entry contracts and exit checks.
- **A coding agent is the floor.** It executes stations with tools, budgets and a lifecycle, and the driving is handed to the model rather than scripted.
- **`AGENTS.md` and `SPEC.md` are the fixtures and tolerances.** Per-project grounding, and a machine-checkable statement of what correct means. A line cannot run unattended without them.
- **Review, verify and the gates are QC.** They pass or fail work without a human reading every diff.

None of it was built to be a factory. It became one because each phase was made repeatable and verifiable on its own terms.

## The job contract

The planned factory assigns each queue item to one self-sufficient job that runs it to a verifiable stopping point.

- **Ownership.** One job owns one queue item end to end, in an isolated worktree.
- **Delegation.** The job may delegate internal triage, implementation slices, simplification and checking, while retaining responsibility for the item and its evidence.
- **Completion.** The job runs until the item is complete, it reaches an explicit fence, or it reaches its failure limit.
- **Environment.** The job records workspace and worker-environment setup and teardown reports. Repository-owned hooks remain responsible for package installation, containers, ports, environment files and service health.
- **Parallelism.** Independent jobs may run in parallel in isolated worktrees. Claims, integration and queue-state transitions remain serialized.
- **Driver.** The factory driver schedules jobs, observes their evidence and integrates completed work. It does not implement the item.
- **Count.** An explicit item count limits a run; the default count is one. The factory does not drain the queue implicitly.

The job returns a delivered-product report containing the item and queue identity, station and delegation tree, worktree and branch, changed files, commit SHA, repo check and result, checker findings and resolutions, updated docs, and final status: completed, blocked, fenced, failed or abandoned. A completed or stopped report includes the evidence the driver needs to land the work or stop at the stated boundary.

Station transfers use the factory's `dim-handoff`. It requires strict `# Handoff — <item_id> — <item name>` and `## Next` headings and carries only the routing token. The ID is canonical and the name comes from the queue. The receiving station queries the job's station, worktree, branch, commits, checks, findings, docs and fence with `dim`; the handoff is not a session-resume document or a second job report.

## Report persistence

The delivered-product report is persisted in the dim database so it remains queryable after the session rather than existing only in chat. `factory_job` is the current projection; `factory_job_event` is its typed append-only lifecycle ledger; and the normalized evidence tables hold commits, changed files, checks, findings, updated documents and worker-environment reports. The record includes:

- **Identity.** Queue and item identity, the item's title, job and run identity, agent identity, worktree and branch.
- **Work.** Station, delegation tree, changed files and commit SHA.
- **Verification.** Repository check command and result, checker findings and their resolutions, and updated docs.
- **Outcome.** Final status — completed, blocked, fenced, failed or abandoned — with fence or blocker evidence and timestamps for the lifecycle events.
- **Environment.** Each setup and teardown report the job attached: the phase, the hook command, its exit code or the signal that killed it, its output, and the resource identifiers the hook named.

A running job attaches a hook report it was handed, and `dim q job` reads it back beside its other evidence. The workspace profile belongs to the planned contract below.

The report lifecycle is a durable sequence from claim through running to completion or a stopped outcome, with evidence recorded as the job progresses. A terminal status cannot transition to another status, and each lifecycle event, its aggregate projection and its paired commit, check or finding evidence are written atomically. `dim q factory [job-id-prefix]` reads one unified current-status row per matching job with selected evidence; `dim q job <job-id>` remains the detailed event-and-evidence view, including every changed file and updated document. These operational tables survive `dim rebuild`, deliberately like `hook_event`, `command_trace` and `finding`: no transcript or file source can recreate a job's claims and judgements after the fact.

## Operator presence

The planned driver boundary is harness-agnostic. Codex, Claude Code, Claude Desktop or another local harness may operate the same factory when it uses `dim` as the record and coordination boundary. The active harness is the operator for that project and factory run.

- **Clock-in.** An operator explicitly clocks in through `dim`, recording the harness, operator identity and session identity before it starts taking work.
- **Clock-out.** The operator explicitly clocks out through `dim` when it stops operating the factory. An unclosed presence remains visible as stale rather than being treated as a clean departure.
- **Scope.** Operator presence belongs to a project and factory, even though the local database is shared across projects. The project uses its canonical `owner/repo` name, so paths and worktrees resolve to one identity. One harness may have separate operator records in several projects.
- **Shared record.** Operator presence, job claims and lifecycle evidence live in the same local database; a harness does not keep a private presence ledger.
- **Concurrency.** Multiple clocked-in operators may observe the same factory. Atomic claims, leases or heartbeats, and serialized queue transitions are required before they may safely execute the same queue concurrently.
- **Wall.** The read-only wall is one shared factory floor: it shows jobs and active operators from every project in the same lifecycle board. Every card and operator carries its canonical `owner/repo` project name. The wall does not provide clock-in, clock-out or job controls.

This is planned, not a current guarantee of multi-driver execution. The current driver still owns scheduling, observation and integration, and the database does not yet provide the cross-driver lease and claim semantics needed to make duplicate execution impossible.

The self-sufficient job contract is live as `runFactoryJob`: it claims one supplied item, marks it running, passes the item and base revision to a builder, and records the builder's terminal outcome and evidence through the existing factory tables. A builder assigns the job's worktree once, may record bounded delegation through `context.delegate`, and stops through `context.stop` or by returning one terminal outcome. Non-terminal lifecycle events and normalized evidence are accepted only while the job is running; a completed job must have a worktree, and no lifecycle or evidence record can be added after a terminal status. A setup or builder exception records `failed` before the exception is returned to the caller. The driver still supplies the worktree and remains responsible for scheduling, observing and integrating the job; queue selection, serialized integration and queue-state enforcement remain outside this slice.

The same lifecycle is reachable from a shell line, because the factory line is a skill driving agents through commands rather than a TypeScript caller. `dim job claim <job-id> --run --queue --item --title` records the claim, with the worktree, branch, agent, session and station it already knows; `dim job start <job-id>` marks it running; and `dim job stop <job-id> <status> [--reason]` records one terminal outcome. A status that is not terminal is refused rather than written, and the ordering rules the job contract already enforces apply unchanged, so a stopped job cannot be started again. Evidence beyond the lifecycle — commits, files, checks, findings and documents — is still written only through the driver.

## Worker environments

The planned workspace contract makes each isolated worker's environment visible without moving its side effects into `dim`.

- **Profile.** The profile identifies the checkout and worktree, languages, package managers, workspace members, declared setup and cleanup entry points, check, format and test tasks, required services, isolation strategy, and resource or secret requirements.
- **Services.** The service names a compose file declares, carrying that file as their source, and nothing past the name. Images, ports, health checks and dependency edges describe a topology the setup hook owns, and a profile repeating them would assert a port no hook had allocated. A repository with no compose file is silent about services, which is a different claim from a compose file that names none; a compose file this cannot read stays silent rather than reporting an empty one.
- **Setup.** `dim wt` invokes the repository's setup hook and records what it reports. The hook may install dependencies, activate pinned tools, create containers, allocate ports, materialize environment files or check service health.
- **Teardown.** Worktree removal invokes the repository's teardown hook first. A failed teardown keeps the worktree and becomes visible in the job report; an explicit force operation is the only override.
- **Boundary.** `dim` owns the worktree lifecycle and evidence. The repository owns package installation, service topology, secrets, ports and resource policy.
- **Parallelism.** Worker-specific names and resources must be isolated by the repository hook, so independent factory jobs cannot share containers, ports or mutable environment state accidentally.

## Queue planning

The queue planner is a reversible, file-backed issue tracker that supplies work to the factory driver without becoming the execution ledger.

- **Queue source.** A tracked file owns the item description, generated title, dependencies and queue status, so planning changes are reviewable, branchable and reversible.
- **Item title.** Intake hands the configured model the stable `queue_id` and `item_id` as metadata, together with the item description and dependencies, and asks for a short durable title, which is what the queue file, the job record and every card call it. The name follows the queue item through every station and retry; it does not replace the identifiers, includes neither identifier, and is never regenerated by a child delegation. A naming failure is a recorded intake fence rather than an invented fallback.
- **Queue format.** The file is JSON with `version: 1`, a queue `id`, and an `items` array. Each item has a non-empty `id`, `title`, optional `description`, `dependencies` array, current `status`, and `transitions` array; an optional `job_id` links the queue item to its current execution report. A transition records literal `from`, `to`, `at`, and optional `reason` values. Unknown fields, missing dependencies, duplicate dependencies, cycles and inconsistent transition history are rejected.
- **Lifecycle.** Items move through explicit states: `planned`, `claimed`, `running`, `completed`, `blocked`, `fenced`, `failed` or `cancelled`. Terminal states do not transition again.
- **Parallel work.** The planner identifies ready items whose dependencies are satisfied. Grouping them into independent isolated jobs, claims and integration remain driver responsibilities.
- **Cancellation.** Cancelling queued work marks it in the queue; ready selection excludes it.
- **Capacity.** The planner exposes bounded ready work rather than creating unlimited jobs.
- **CLI.** `dim queue ready <file> [--limit <n>]` prints planned items in stable ID order, and `dim queue transition <file> <item> <status> [--reason <text>] [--at <iso>]` validates and atomically writes a status transition back to the file.
- **Serialization.** The driver keys claims and integration by queue and item, so work sharing a key is serialized while independent keys can run in parallel.
- **Boundary.** The queue file owns intent and dependency state; `factory_job` owns execution identity, lifecycle events and evidence. The driver translates between them.

The queue may carry a compact current status and `job_id` link for a person reading the plan. The delivered-product report remains in `factory_job` and its evidence tables: commits, changed files, checks, findings, documents, and fence or blocker evidence. The queue is not a second report store. `dim q factory` continues to report persisted jobs; it does not infer execution reports from the queue file.

This planner does not add a second source of truth for job reports.

## Scheduling

The planned scheduler makes recurring factory runs visible without choosing the host that wakes them.

- **Definition.** `dim` owns a schedule's identity, target queue, due policy and enabled or paused state.
- **Due work.** The driver asks `dim` which schedules are due, claims the eligible queue work and records the run and jobs in the existing factory tables.
- **Host boundary.** Codex, launchd, cron or another host only invokes `dim`; it does not own schedule state, claim work or write a second report.
- **Repeatability.** A repeated invocation reads persisted schedule and job state, so it does not start a second active run for the same serialized key.
- **Visibility.** The factory status query will show schedule state, due work, active runs, terminal outcomes and fences from the same persisted record.
- **Control.** Pausing a schedule prevents new claims while preserving its history. A fence or repeated failure is recorded and remains visible to the next invocation.

The first slice is live: `dim schedule define` persists an interval schedule, `dim schedule pause|resume` controls its enabled state, and `dim q schedules` reads the persisted definitions and due selection. Installing or mutating a host scheduler, claiming queue work and recording job execution remain outside that slice.

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

### A gate earns its automation from a record

Planned. "On its own merit" needs something to read the merit off, and the owner's verdicts are not written down anywhere today. `factory_job_finding` records an agent's finding with the grounds a refusal rested on; the owner's decision on a finished job has no such row.

The two things a verdict is passed on already have writers. [`dim-station-plan`](../skills/dim-station-plan/SKILL.md) returns a plan in slices, and the `explain-diff` skill reads a built diff back as intent and risk. Neither persists against a job, so both end in a transcript; an account written for the owner also names the commits it describes, since that is what makes it checkable rather than trusted.

- **The verdict.** Per job: landed as it came, sent back, or changed before landing — with the grounds whenever it was not the first.
- **What it answers.** Which kinds of work stopped needing a reading, and which still earn one. That is the question "how involved should I be" resolves into, and it is a query over verdicts rather than a memory of how the last few felt.
- **Why it is not optional.** A gate that is always on and never recorded reads the same as one nobody is exercising. Recording the verdict is what separates a gate being held from a gate being waved through, and a relaxation that follows from rows is reversible in a way that one following from fatigue is not.

Reviewing everything is the honest starting point, because a gate cannot earn its way out of a record that was never kept.

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
