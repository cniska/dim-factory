# The factory

The argument this repo exists to execute. It is a position to argue with, not a description of what is built — what is built is in [`README.md`](../README.md), and what it is measured against is in [`goals.md`](goals.md).

## The line already exists

The owner's tool-agnostic engineering skills form a production line — spec, plan, build, review, ship — and the parts map onto a factory more cleanly than they were designed to.

- **Skills form the line and stations.** `dim-line-feat` and `dim-line-fix` are line entry points; `dim-station-plan`, `dim-station-build` and `dim-station-review` are repeatable stations with entry contracts and exit checks.
- **A coding agent is the floor.** It executes stations with tools, budgets and a lifecycle, and the driving is handed to the model rather than scripted.
- **`AGENTS.md` and `SPEC.md` are the fixtures and tolerances.** Per-project grounding, and a machine-checkable statement of what correct means. A line cannot run unattended without them.
- **Review, verify and the gates are QC.** They pass or fail work without a human reading every diff.

None of it was built to be a factory. It became one because each station was made repeatable and verifiable on its own terms.

## The order contract

The planned factory assigns each queue item to one self-sufficient order that runs it to a verifiable stopping point.

- **Ownership.** One order owns one queue item end to end, in an isolated worktree.
- **Delegation.** The order may delegate internal triage, implementation slices, simplification and checking, while retaining responsibility for the item and its evidence.
- **Completion.** The order runs until the item is complete, it reaches an explicit hold, or it reaches its failure limit.
- **Environment.** The order records workspace and worker-environment setup and teardown reports. Repository-owned hooks remain responsible for package installation, containers, ports, environment files and service health.
- **Parallelism.** Independent orders may run in parallel in isolated worktrees. Claims, integration and queue-state transitions remain serialized.
- **Operator.** The operator schedules orders, observes their evidence and integrates completed work. It does not implement the item.
- **Count.** An explicit item count limits a run; the default count is one. The factory does not drain the queue implicitly.

The order returns a delivered-product report containing the item and queue identity, station, worktree and branch, changed files, commit SHA, repo check and result, checker findings and resolutions, updated docs, and final status: completed, blocked, held or failed. A completed or stopped report includes the evidence the operator needs to land the work or stop at the stated boundary.

Station transfers use the factory's `dim-handoff`. It requires strict `# Handoff — <item_id> — <item name>` and `## Next` headings and carries only the routing token. The ID is canonical and the name comes from the queue. The receiving station queries the order's station, worktree, branch, commits, checks, findings, docs and hold with `dim`; the handoff is not a session-resume document or a second order report.

## Report persistence

The delivered-product report is persisted in the dim database so it remains queryable after the session rather than existing only in chat. `factory_order` is the current projection; `factory_order_event` is its typed append-only lifecycle ledger; and the normalized evidence tables hold commits, changed files, checks, findings, updated documents and worker-environment reports. The record includes:

- **Identity.** Queue and item identity, the item's title and the description the queue gave it, order and run identity, agent identity, worktree and branch.
- **Work.** Station, every move between stations, the worker each moment is attributed to, commit SHA, and each changed file with the lines added and removed where the recorder counted them.
- **Verification.** Repository check command and result, checker findings and their resolutions, and updated docs.
- **Outcome.** Final status — completed, blocked, held or failed — with hold or blocker evidence and timestamps for the lifecycle events.
- **Environment.** Each setup and teardown report the order attached: the phase, the hook command, its exit code or the signal that killed it, its output, and the resource identifiers the hook named.

The item's description is copied into the record at claim time rather than read from the queue when someone asks, under the name the queue itself uses for that field. The queue is edited as work lands, so the wording an order was worked to survives only where the claim kept it; an order claimed off a queue that names its items and nothing more carries a title and no description.

A running order attaches a hook report it was handed, and `dim q order` reads it back beside its other evidence. The workspace profile belongs to the planned contract below.

## Done

An order is done when its check passed on the final commit, every finding was answered by a fix or a refusal with grounds, the docs describing the behavior changed in the same commit as the behavior, its commits are reachable from the repo's trunk, and its worktree is gone.

Two of those are mechanical and `dim order stop <order> completed` refuses an order that fails either. The check condition: a check that exited zero, recorded no earlier than the order's last commit. The trunk condition: at least one recorded commit that is an ancestor of the trunk. The other three rest on the station loop, because nothing in the record can tell a finding answered with grounds from one waved through, a doc that describes the behavior from one that mentions it, or a worktree removed on purpose from one never made.

Each refusal carries its own code — `order_not_checked`, `order_not_integrated`, `order_trunk_unknown` — so a operator can tell which condition failed without reading the prose. `blocked`, `held` and `failed` carry no requirement at all, because they are how an unfinished order stops and refusing them would push a operator toward recording the wrong outcome.

A check that passed and was then committed over is the case the check condition exists to catch, and an order with no commit recorded has nothing for its check to be older than. Both sides of that comparison are the time the row was written, so the shell and the operator are judged on one clock; a check may still say when it truly ran, which on a loop that checks before committing is earlier than the commit it vouches for. Those recorded times therefore say when evidence was written rather than how long an order spent verifying.

A branch that is finished and unmerged is where work rots, which is why reaching the trunk is part of being done rather than a step after it. That fixes the order: merge, then complete the order, then remove the worktree — the gate reads git out of the order's worktree, so a worktree taken away first leaves nothing able to say where the commits went. Which branch that is comes from `refs/remotes/origin/HEAD`, written by `git clone` and by nothing else, so no agent assumes the name; the commit is tested against the local branch of that name, because integration means the branch the next worker starts from. A repo that cannot be placed against a trunk is refused rather than waved through, since what is unreadable there is what integration means, not whether the commit reached it, and the refusal says which of those readings failed: no trunk named, a trunk named with no local branch, or a worktree that is no longer a repo. A commit the repo does not have at all is reported as missing rather than as unmerged, because a sha nobody can find is not evidence of a branch left behind. `dim doctor` already reports the checkouts that name no trunk.

Where the gate sits has consequences. A shell caller that is refused keeps the order working, so recording what is missing and stopping again is the way through; a builder under the operator that returns `completed` unready is recorded as `failed` and its exception is returned to the caller, because the gate fires inside the operator's own error path and a terminal status takes no further event. And the gate has no skip: `DIM_SKIP_CHECK` exists for the pre-commit hook, where git's own `--no-verify` would otherwise take the subject gate with it, and the argument for this gate is that on 2026-09-18 a line used that variable to bypass a check with nothing refusing it, and only `dim q slices` said so afterward. A operator supplying its own timestamps can still place a check where it likes, so the gate holds against forgetting rather than against a caller that means to get around it.

The report lifecycle is a durable sequence from claim through working to completion or a stopped outcome, with evidence recorded as the order progresses. A terminal status cannot transition to another status, and each lifecycle event, its aggregate projection and its paired commit, check or finding evidence are written atomically. `dim q factory [order-id-prefix]` reads one unified current-status row per matching order with selected evidence; `dim q order <order-id>` remains the detailed event-and-evidence view, including every changed file and updated document. These operational tables survive `dim rebuild`, deliberately like `hook_event`, `command_trace` and `finding`: no transcript or file source can recreate an order's claims and judgements after the fact.

## Operator presence

The planned operator boundary is harness-agnostic. Codex, Claude Code, Claude Desktop or another local harness may operate the same factory when it uses `dim` as the record and coordination boundary. The active harness is the operator for that project and factory run.

- **Clock-in.** An operator explicitly clocks in through `dim`, recording the harness, operator identity and session identity before it starts taking work.
- **Clock-out.** The operator explicitly clocks out through `dim` when it stops operating the factory. An unclosed presence remains visible as stale rather than being treated as a clean departure.
- **Scope.** Operator presence belongs to a project and factory, even though the local database is shared across projects. The project uses its canonical `owner/repo` name, so paths and worktrees resolve to one identity. One harness may have separate operator records in several projects.
- **Shared record.** Operator presence, order claims and lifecycle evidence live in the same local database; a harness does not keep a private presence ledger.
- **Concurrency.** Multiple clocked-in operators may observe the same factory. Atomic claims, leases or heartbeats, and serialized queue transitions are required before they may safely execute the same queue concurrently.
- **Wall.** The read-only wall is one shared factory floor: it shows orders and active operators from every project in the same lifecycle board. Every card and operator carries its canonical `owner/repo` project name. The wall does not provide clock-in, clock-out or order controls.

This is planned, not a current guarantee of multi-operator execution. The current operator still owns scheduling, observation and integration, and the database does not yet provide the cross-operator lease and claim semantics needed to make duplicate execution impossible.

The self-sufficient order contract is live as `runFactoryOrder`: it claims one supplied item, marks it working, passes the item and base revision to a builder, and records the builder's terminal outcome and evidence through the existing factory tables. A builder assigns the order's worktree once and stops through `context.stop` or by returning one terminal outcome. Non-terminal lifecycle events and normalized evidence are accepted only while the order is working; a completed order must have a worktree, and no lifecycle or evidence record can be added after a terminal status. A setup or builder exception records `failed` before the exception is returned to the caller. The operator still supplies the worktree and remains responsible for scheduling, observing and integrating the order; queue selection, serialized integration and queue-state enforcement remain outside this slice.

The same lifecycle is reachable from a shell line, because the factory line is a skill driving agents through commands rather than a TypeScript caller. `dim order claim <order-id> --run --queue --item --title` records the claim, with `--description` for the item's own words and the worktree, branch, agent, session and station it already knows; `dim order start <order-id>` marks it working; `dim order move <order-id> --station <name>` records that the work reached another station; and `dim order stop <order-id> <status> [--reason]` records one terminal outcome. A move carries the projection a card is read by and leaves the station it came from in the ledger, so the route an item took is readable after the fact. A status that is not terminal is refused rather than written, and the ordering rules the order contract already enforces apply unchanged, so a stopped order cannot be started again. Evidence beyond the lifecycle has the same route: `dim order commit`, `dim order file`, `dim order check`, `dim order finding` and `dim order document` each write one row, under the rules the order contract already holds; `dim order file` takes `--added` and `--removed` as `git diff --numstat` counts them, and records no count for the `-` numstat gives a binary file — an order that has not started and an order that has stopped both refuse them. A worker-environment report is still attached only through the operator, which is what runs the hook that produces one.

## Worker environments

The workspace contract makes each isolated worker's environment visible without moving its side effects into `dim`. The profile is live in [`workspace.ts`](../src/workspace.ts); the isolation strategy is the one profile element with no value behind it.

- **Profile.** The profile identifies the checkout and worktree, languages, package managers, workspace members, declared setup and cleanup entry points, check, format and test tasks, required services, isolation strategy, and resource or secret requirements. Each declared value is read from a file the repository writes and carries that file as its source.
- **Services.** The service names a compose file declares, and nothing past the name. Images, ports, health checks and dependency edges describe a topology the setup hook owns, and a profile repeating them would assert a port no hook had allocated. A repository with no compose file is silent about services, which is a different claim from a compose file that names none; a compose file this cannot read as a mapping stays silent rather than reporting an empty one, and an override file is not merged in because which override applies is a Compose invocation's business.
- **Requirements.** The environment variable names a tracked sample file declares. Only the names: the filled-in `.env` is never opened, no part of a value is recorded, and a name is the whole of what a worker needs in order to know it must be given a value. A value quoted across several lines is followed to its closing quote, so a key body cannot be mistaken for a further name. A sample file has no unreadable state — a line either declares a name or does not — so silence here means only that the repository wrote no sample file. The repository remains the authority for where a value comes from, and for the requirements that are not variables at all: containers, ports and disk.
- **Isolation.** Nothing a repository writes today says how two parallel workers avoid sharing a container, a port or a mutable environment file, so the profile reports no isolation strategy rather than deriving one. Acolyte states the governing rule — detect what the host can prove from the workspace, declare what only the project can know — and its own parked contract stops at ordered setup and teardown command lists for the same reason. Naming the declaration that would close this asks every repository to write something new, which is the owner's to settle.
- **Setup.** `dim wt` invokes the repository's setup hook and records what it reports. The hook may install dependencies, activate pinned tools, create containers, allocate ports, materialize environment files or check service health.
- **Teardown.** Worktree removal invokes the repository's teardown hook first. A failed teardown keeps the worktree and becomes visible in the order report; an explicit force operation is the only override.
- **Boundary.** `dim` owns the worktree lifecycle and evidence. The repository owns package installation, service topology, secrets, ports and resource policy.
- **Parallelism.** Worker-specific names and resources must be isolated by the repository hook, so independent factory orders cannot share containers, ports or mutable environment state accidentally.

## The queue

Every piece of work is an order, waiting or worked, and `factory_order` is the one table that holds it. There is no separate item: an order is written down before anyone takes it, and a worker taking it fills in the run, the agent and the claim time the row was created without.

- **Queue source.** The rows are stated in [`src/schema.ts`](../src/schema.ts) and nothing on disk holds them. Two orders adding work while they run is a write each rather than the lost write one file would take.
- **Identity.** An order's `id` is the subject, and it is also the branch and the name of the worktree directory the work is built in — one string the record states once rather than three that can disagree. It exists before any run, so it carries no run timestamp. `project` is the canonical `owner/repo`, so one board carries more than one project.
- **Title.** Intake asks the configured model for a short durable title, which is what the order record and every card call it. A queue seeded from a document that already argues the work takes its ids, titles and statements from that document, and intake names only what arrives without one.
- **Lifecycle.** An order is `queued`, `working`, `completed` or `failed`. A claim takes it straight to `working`, because an order already exists before a worker sees it and taking one is starting it. Only `completed` ends it: work that stopped without landing is work nobody is holding, so a failed order is claimed again in place, and the attempts at a subject are the claims recorded against its row.
- **Ordering.** Priority alone, urgent first and unset last, then oldest, then id. Nothing expresses that one order blocks another, because an order is queued when it is ready to be built and work that is not ready is not queued.
- **The hold.** `hold` says why the owner has to release an order before anyone takes it, and a claim on a held order is refused. A hold met while the work is running is recorded the same way, so what happened to the attempt and who may let the work go stay two facts.
- **CLI.** `dim order add <order-id> --title "..."` queues one, including from inside a running order; `dim order ready [--limit <n>]` prints the orders nobody holds as JSON, most urgent first and oldest before newest within a priority, with the held ones listed beside them rather than silently absent; `dim order priority`, `dim order hold` and `dim order release` amend one. All default to the checkout's own `owner/repo`.
- **Parallel work.** Grouping ready orders into independent isolated runs, claims and integration remain operator responsibilities.
- **Serialization.** The operator keys claims and integration by order, so work sharing a key is serialized while independent keys can run in parallel.
- **Capacity.** An explicit count bounds a run; the default is one. The factory does not drain the queue implicitly.

The delivered-product report is the same row and its evidence tables: commits, changed files, checks, findings, documents, and the reason an order stopped.

## Scheduling

The planned scheduler makes recurring factory runs visible without choosing the host that wakes them.

- **Definition.** `dim` owns a schedule's identity, target queue, due policy and enabled or paused state.
- **Due work.** The operator asks `dim` which schedules are due, claims the eligible queue work and records the run and orders in the existing factory tables.
- **Host boundary.** Codex, launchd, cron or another host only invokes `dim`; it does not own schedule state, claim work or write a second report.
- **Repeatability.** A repeated invocation reads persisted schedule and order state, so it does not start a second active run for the same serialized key.
- **Visibility.** The factory status query will show schedule state, due work, active runs, terminal outcomes and holds from the same persisted record.
- **Control.** Pausing a schedule prevents new claims while preserving its history. A hold or repeated failure is recorded and remains visible to the next invocation.

The first slice is live: `dim schedule define` persists an interval schedule, `dim schedule pause|resume` controls its enabled state, and `dim q schedules` reads the persisted definitions and due selection. Installing or mutating a host scheduler, claiming queue work and recording order execution remain outside that slice.

## What is missing is not another skill

Two layers separate a set of stations from a line that runs itself, and neither is more instruction.

1. **Someone to start the work.** A factory runs when work begins without a person starting each task. The queues already exist — the rows `dim order ready` reads, a tracker, a list of issues — so what the stations lack is not a place for work to wait but something that reads one and opens the order. `dim-factory` does that: it takes a queue rather than keeping one, so a file it is handed, a tracker the repo declares and what it finds by looking all reach the same reader; it picks an order, routes it to the station whose shape fits, and holds the run inside the bounds below rather than judging them. For this repo the queue is the rows `dim order ready` prints, whose work [`build-order.md`](build-order.md) argues under the same ids.
   The operator passes the item and base revision to the builder. The builder creates its isolated checkout with `dim wt` before invoking its line or station and owns the work from there.
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

Planned. "On its own merit" needs something to read the merit off, and the owner's verdicts are not written down anywhere today. `factory_order_finding` records an agent's finding with the grounds a refusal rested on; the owner's decision on a finished order has no such row.

The two things a verdict is passed on already have writers. [`dim-station-plan`](../skills/dim-station-plan/SKILL.md) returns a plan in slices, and reading a built diff back as intent and risk is what the reviewing station does. Neither persists against an order, so both end in a transcript; an account written for the owner also names the commits it describes, since that is what makes it checkable rather than trusted.

- **The verdict.** Per order: landed as it came, sent back, or changed before landing — with the grounds whenever it was not the first.
- **What it answers.** Which kinds of work stopped needing a reading, and which still earn one. That is the question "how involved should I be" resolves into, and it is a query over verdicts rather than a memory of how the last few felt.
- **Why it is not optional.** A gate that is always on and never recorded reads the same as one nobody is exercising. Recording the verdict is what separates a gate being held from a gate being waved through, and a relaxation that follows from rows is reversible in a way that one following from fatigue is not.

Reviewing everything is the honest starting point, because a gate cannot earn its way out of a record that was never kept.

## A role runs at the tier its work needs

Every station names its agents by role and brief — operator, planner, builder, simplifier, reviewer, checker, judge, and the search that finds where a thing already lives. Each role runs at one of three capability tiers, declared in [`src/routing.ts`](../src/routing.ts) and never worked out from the work at hand, which is the rule `src/workspace-commands.ts` already follows for a repo's check.

- **`cheap`** reads one thing against a fixed brief: check one diff against four closed questions, settle one disputed claim at its source, find where a shape exists on disk. That is the checker, the judge and the search.
- **`standard`** makes the mechanical edit and the doc that goes with it: the builder, the simplification pass, and a review dimension reading an assembled change.
- **`deep`** cuts the work and decides where the line stops: the planner, and the operator whose stopping rule is the substance of this file.

What a tier is called locally is a separate thing, and it is data rather than code. `routing.json` beside the database maps `cheap`, `standard` and `deep` to whatever the harness driving the floor calls them; another harness writes its own names, and a harness with one model maps all three to it and loses nothing. `dim route <role>` prints the tier and the mapped name, so a station says "spawn the checker at the tier `dim route checker` gives you" and names no model. No model name appears in this repo's source or in a skill, and a test fails when one does.

The map is per machine and not per repo. Which models exist is a property of the harness driving the line, not of the code being worked on, and the same factory run from a different harness must resolve differently; a repo-level override waits until something asks for one.

**A map that does not say exactly one thing refuses to route.** That covers a file that is absent, a tier left unnamed, a key that is no tier, and a tier named twice — which JSON resolves to the last value without complaining, so a copied line would quietly change the model every cheap role runs on. `dim route` names the file and what is wrong with it, and exits nonzero. A default tier chosen here would be a guess about cost and capability made where nobody would see it, and the run that silently took it is the one that cost the most.

This is the first preference `dim` holds rather than a record of something that happened, and it is worth saying plainly because everything else here is history. It qualifies: it is one file, hand-written, read and never inferred, and it is the machine's answer to a question the record cannot answer — no row says what a model is called here. Whether a cheap checker raises fewer real findings than an expensive one is still a measurement, and it waits on the tier being recorded against an order.

## What the assembly line already settled

Borrowed, and each kept only where a mechanism here carries it. The names are worth keeping because they are searchable, and because each one names a mistake that is easy to make twice.

- **Stop on a defect, never on success** (*jidoka*). A machine that detects an abnormality halts itself rather than passing the part along. The `pre-commit` gate is this: the check fails, git refuses, nothing downstream sees it. The factory operator halts on a second failure of one item and on two failures in a row, and on nothing else — finishing an item is not a reason to stop a line.
- **Anyone may halt the line** (*andon*). A checker's finding stops its slice until the finding is answered, by a fix or by a stated refusal. The same for a finding that keeps recurring is unbuilt; [`build-order.md`](build-order.md) holds it.
- **Fix the process, not the part.** A defect found once is repaired; a defect found repeatedly is a gate that does not exist yet. `dim q findings` counts by dimension, which is what names the candidate. The worked example is a diagnostic written through a console API: the instance was fixed, and then `noConsole` in [`biome.json`](../biome.json) stopped the class being representable.
- **Make the error impossible rather than forbidden** (*poka-yoke*). The argument under "Checks use model judgement, not pattern matching" in [`AGENTS.md`](../AGENTS.md): express as a gate whatever is mechanical, and leave to judgement only what needs it.
- **One piece at a time.** A slice is verified and committed before the next begins. A branch of unverified slices is one slice with a long diff, which is a batch waiting to be reworked.
- **Go and see** (*genchi genbutsu*). Verify a claim at its source rather than from a plausible reading of it. A number quoted without being measured is what this is against, and [`findings.md`](findings.md) holds a case of it.
- **The operator does not work the line.** Whoever runs the queue hands each item to a builder and watches what the line does — what is stuck, what fails twice, whether the gates still hold. Hands in one diff is attention off every other station.

What does not transfer is takt time. Pacing output to demand assumes interchangeable units, and a slice is not one; a cadence would manufacture work to fill it, which [`loop.md`](loop.md) rejects for the same reason it rejects a scheduled sweep.

## What follows from it

Merit means evidence, which is why this repo collects any. [`goals.md`](goals.md) states what the factory is measured against and in what order. [`findings.md`](findings.md) is what the corpus said when it was first asked. [`loop.md`](loop.md) is how a rule that stopped earning its place gets cut, and [`evals-and-hooks.md`](evals-and-hooks.md) is the instrument that decides whether it was earning one.
