# The factory

The argument this repo executes, and how the factory works today. [`my-workflow.md`](my-workflow.md) is the workflow it replaces; [`goals.md`](goals.md) is what it is measured against.

## Dim, not dark

A factory with no human reading the work ships whatever the checks miss, and the checks do not catch a coherent, confident, wrong design. So:

- **Autonomous between the gates.** Once a direction is agreed, agents read, write, verify and recover without asking at every branch.
- **A human at the gates that matter.** Hard-to-reverse, outward-facing or ambiguous work waits for the owner.
- **Each gate earns its automation from a record.** Every approval and return is an attributed event, so which kinds of work stopped needing a read is a query over verdicts, not a feeling. Reviewing everything is the starting point, because a gate cannot earn its way out of a record never kept.

## Trust across projects

The factory aims to give each project the conditions that let its owner delegate work with evidence:

- **Codebase quality.** Clear boundaries, current docs and tests give a worker a reliable starting point. [`dim-audit`](../skills/dim-audit/SKILL.md) inspects an existing project and reports debt for the owner to turn into work.
- **Static analysis and tests.** The project declares the check it needs; the commit gate and factory runner execute it before accepting code ([`usage.md`](usage.md#commit-gate)).
- **Rules.** Standing instructions tell agents what holds throughout a project. Mechanical rules become gates, which still run when an agent misses an instruction ([`usage.md`](usage.md#install-the-shared-controls)).
- **Skills.** Shared, task-specific procedures guide planning, building, review and audit. [`dim-setup`](../.agents/skills/dim-setup/SKILL.md) installs them for use from other projects.
- **Style guide.** The project's conventions and examples show what its code and docs should look like: names, file boundaries, API patterns and writing. Formatting is one enforceable part; reviewers judge conventions that tools cannot decide. [Google's style guide overview](https://github.com/google/styleguide/blob/gh-pages/README.md) uses the term for conventions ranging from names to design choices.

Setup already installs the shared controls, while each project still supplies its declared check and local conventions. [`dim adopt`](todo.md) is planned to establish the project baseline in one step. An audit reports codebase quality problems; fixing them remains work with its own evidence and approvals.

## The line

- **Skills are the stations.** `dim-feat` and `dim-fix` are the entry points; `dim-plan`, `dim-build` and `dim-review` are the stations.
- **The same three stations serve every line**, each routing on the line its brief names.
- **Coding agents are the floor.** Each station runs as a worker in Claude Code, Codex or Grok Build.
- **The repo's `AGENTS.md` sets the tolerances.**
- **Checks, review and gates are QC.**

## An order

One piece of work, written down before anyone takes it ([`glossary.md`](glossary.md)). Its id is also its branch and its worktree, `<repo>/.claude/worktrees/<order-id>`.

```text
queued → plan → build → review → ship → shipped
```

- **Where an order is, is read from the record** ([`src/order-state.ts`](../src/order-state.ts)): its station and the act that station waits on — run the station, or approve its artifact. Approving the Review artifact ships the order, so the next act is ship only after a ship that failed without sending the order back to a station. Nothing stores it and no command sets it, the status included: an order is `queued` until it starts, `running` until it ships or is dropped, then `shipped` or `dropped`.
- **Every act checks on entry** that it is the act the record waits on, and a refusal names the one that is. `dim order plan` on a queued order starts it and makes its worktree.
- **The operator** delegates each station to a worker, checks each artifact against the record, and approves it or returns it. It never does the work.
- **Each station returns an artifact** — plan, Build artifact, Review artifact — that the operator approves (`dim order approve`) or sends back with a reason (`dim order return`).
- **Build runs slice by slice.** One `dim order build` runs each remaining slice, and the runner checks and commits that slice before the next starts. Review reads the whole order after the last one. A round's findings send the order back to build, where the builder answers each one once, `fixed` or `refused` with a reason. The next round is briefed with those answers and raises a new finding for any that still holds; a round that raises nothing writes the Review artifact.
- **An order returns to the station that can correct it.** During build, the operator uses `dim order return <id> --to plan --reason "..."` when the approved plan needs revision. During review approval, `--to build` sends a code correction to the builder. A return without `--to` sends the current artifact to its worker for revision. Every return sends back the artifact awaiting approval along with the destination's, and is refused while an attempt runs on the order. The revised plan needs approval before build resumes from its slices. A plan revision needs fresh Build and Review approvals, and Review reads the whole order again.
- **Ship** follows the Review approval and ends the order (see [Shipped](#shipped)).
- **A failed attempt** leaves the order where its evidence puts it, and the same command runs the station again. A build attempt running on an order refuses a second one. **A drop** is the owner deciding it will not be built. A started order's worktree stays available for inspection; `dim wt rm <id>` removes it after its work is saved.
- **One act, one path.** Findings arrive only in the reviewer's report and answers only in the builder's build turn. Commits, files, checks and Build artifacts are written by the build runner and by ship, and Review artifacts by the review station; no command writes them.

### Commands

```sh
dim order add <id> --title "..." [--line feat|fix] [--description "..."]
dim order ready                          # the queue
dim order priority|amend|drop <id> ...
dim order plan|build|review <id> [--harness codex|claude|grok]
dim order approve <id> [--reason "..."]  # a Build artifact's approval requires --reason; a Review artifact's ships
dim order return <id> --reason "..." [--to plan|build]
dim order ship <id>                      # retries a ship that failed with no station's work to do
dim q order <id>                         # one order's full record and its next act
dim q factory                            # every order's current state
dim trace <id>                           # diagnostic events, followed live
```

`dim q order <id>` places the order's current `status` and `next` act in adjacent columns of its first row. The first row's `evidence` is its priority; terminal orders show `(none)` in `next`. Lifecycle and evidence rows keep their own `status`, `subject`, and `evidence`, with an empty `next` cell.

A command with no `--harness` runs the worker under the harness the operator's own session is in.

## The build turn

A builder leaves its changes uncommitted and returns a build turn: a commit subject, an answer per finding, and the Build artifact on every turn but one that finishes an earlier slice. A returned Build artifact runs a build turn too, briefed with the owner's feedback, and it may change code. The runner then ([`src/station-build-commit.ts`](../src/station-build-commit.ts)):

1. refuses a turn that leaves a handed finding unanswered or answers one it was not handed
2. applies the comment gate over the staged tree, reading the ban from the local default branch's config so a builder cannot lift it
3. runs the check the local default branch declares, in the worktree's check sandbox; a turn that redefines that task in its manifest fails before it runs, so a builder cannot redefine the check its own code is held to ([`src/workspace-tasks.ts`](../src/workspace-tasks.ts) `trunkCheck`). The sandbox's environment holds only what a process needs to run — `PATH`, `HOME`, the user, shell, temporary directory, locale and time zone — so no credential, factory name or proxy reaches it ([`src/station-environment.ts`](../src/station-environment.ts))
4. commits with the repo's own identity and signing, and records the commit under the builder and the check at the commit it ran on — the new commit, or for a turn that failed or changed nothing the head it was built on ([`src/order-head-check.ts`](../src/order-head-check.ts))

The default branch's declaration governs until a change to it lands there. An order may add tasks, and a task it adds above the declared one in the check order is not the check until it ships. An order may not change the declared task's definition, its script, recipe or package manager: that change is the owner's, made on the default branch, and the order's next turn is checked by it.

A refused commit or comment goes back to the same builder, at most twice per turn. A red check, a redefined check, a check that changed the tree, a nested repository, or HEAD moved off the order's branch fails the turn, and the reason is in the next turn's brief.

## Shipped

Landing an order's commits on the local default branch ships it. Ship then removes its worktree, and deletes its branch if the branch tip reaches the local default branch. A worktree or branch that cannot be removed is kept; the ship run records the reason under `worktree_kept` or `branch_kept`, and `dim order ship` reports it. Nothing is pushed. Ship waits on an approved Build artifact, which the runner writes only with a check that passed at the head, and on an approved Review artifact at the head; the docs changing with the behavior rest on the stations. Approving the Review artifact ships; `dim order ship` retries, and writes a `ship_retried` event under the operator before the attempt.

Every ship writes one [ship run](glossary.md#the-record), whatever its outcome and before any refusal reaches the caller. The rebase and the landing are the factory's acts, so a ship run names no worker and the history shows neither; `dim q order` lists the runs and the commits they rewrote. The order is `shipped` once a run lands it.

Ship lands the order the way the repo declares with `git config dim.ship`:

- **`trunk`** fast-forwards the local default branch to the order's branch. If the default branch has moved ahead, the order's branch is first rebased in its worktree and re-checked with the check the default branch declares, as the build runner does.
- **`pull-request`** is declared but not built, and refused.
- A repo that declares nothing, or an unknown value, is refused, so no agent guesses how a repo ships.

Around it:

- `refs/remotes/origin/HEAD` identifies the default branch; ship lands on the local branch of that name.
- Ship runs under the factory lock, since two ships would race on one checkout.
- A build approval carries through every rebase, since the rebase replays approved commits and re-checks them; a review approval carries only through one whose patches are equal. So a rebase that changed a patch puts the order back at review, reading the whole order from the new base, and a conflict puts it back at build: the builder resolves the paths in place, and the runner continues the rebase instead of committing ([`src/station-build-rebase.ts`](../src/station-build-rebase.ts)).
- A red re-check keeps the rebase and puts the order back at build, where a build turn briefed with the check's output fixes the rebased head ([`src/order-head-check.ts`](../src/order-head-check.ts)). Its commit takes a new Build approval and a new review round before the order ships.
- A rebase is recorded as a rewrite: each retired sha stays in the record and never counts as landed, reviewed or current.
- A conflict stays pending while the latest ship run is a conflict and no commit names it.
- When commits remain to land, ship refuses a dirty default branch checkout, an unrecorded branch tip, or an unsigned commit where the repo signs. Before a rebase, it also refuses a dirty or nested order worktree.

## Workers

- **An act's worker is written with the act**, never attributed afterwards.
- **Identity is the process tree.** Every worker is registered as a process, a pid and its start time, and a `dim` command resolves to the nearest registered process above it; no file or variable a worker can read grants an identity ([`src/worker.ts`](../src/worker.ts)). A running station command registers itself as a barrier, so what it spawns before a worker is registered resolves to no one rather than to the operator above it.
- **The operator** is registered by `dim operator`, which takes the active session in this checkout's `owner/repo` and registers that session's harness process when it is an ancestor of the caller.
- **Station workers** are issued through assignments. One worker per station per order keeps its provider session, so a later turn resumes it with its context. A failed harness run releases that worker, and the next command briefs a new one from the record. A returned turn whose artifact or check fails keeps its worker for correction. A worker bound to one harness is refused under a `--harness` that names another.
- **A usage limit moves the station to a harness with capacity.** An attempt a harness's usage limit stopped finishes `limited`, with the reset time the harness reports ([`src/station-worker.ts`](../src/station-worker.ts)). Without `--harness`, a station command runs on the first harness with capacity — the bound worker's, then the operator's own, then each one `routing.json` maps — releasing a worker bound to a limited harness, and moves on when a run is limited. A limit counts until its reset passes, or, with no reset reported, until a later attempt on that harness; with none left the command refuses with `harnesses_limited` ([`src/station-harness.ts`](../src/station-harness.ts)).
- **Station attempts** start when a planner, builder, or reviewer run receives its worker identity. The runner records the outcome; if a worker stops without one, the next run records that attempt as failed before starting. A failure before assignment records the station and reason with no worker.
- **A worker is over when its process stops answering** a signal ([`src/worker.ts`](../src/worker.ts)); nothing needs to be awake to notice.
- **A worker's environment is an allowlist**, never the owner's: what the check gets, `dim`'s own data locations, the worker's factory name, and exactly the variables its harness adapter declares — its config directory, its subscription login where the harness takes one from a variable, and the network proxy and CA it reaches its model through ([`src/station-environment.ts`](../src/station-environment.ts)). So the operator's identity and session, API keys, forge tokens and agent sockets never reach it, and no worker is billed per token. A Claude worker cannot start background work.
- **Sandboxes.** No worker gets the checkout's git metadata. Codex builders run `workspace-write`, everything else read-only. Claude workers run in its Bash sandbox with `.git` denied. Grok builders run the `workspace` sandbox and every other Grok worker `read-only`. A Grok worker that cannot edit is denied the edit tools, and every Grok worker is denied those tools on `.git`.

## Roles and tiers

Each role runs at a tier declared in [`src/worker-routing.ts`](../src/worker-routing.ts): the planner, the reviewer and the operator at `deep`, the builder at `standard`. The machine's `routing.json` maps each harness's models to the tiers, and `dim route` refuses a map that does not say exactly one thing. No model name appears in this repo.

A station asks for capabilities, never a harness's flags ([`src/worker-capabilities.ts`](../src/worker-capabilities.ts)); each harness adapter maps them ([`src/harness-codex.ts`](../src/harness-codex.ts), [`src/harness-claude.ts`](../src/harness-claude.ts), [`src/harness-grok.ts`](../src/harness-grok.ts)).

## Worker environments

- The workspace profile ([`src/workspace.ts`](../src/workspace.ts)) names the checkout's languages, package managers, workspace members, tasks, compose services and the variable names a sample env file declares — never a value.
- The repository's setup and teardown hooks own every side effect ([`worktrees.md`](worktrees.md)); `dim` records what they report against the order.
- A repository states no isolation strategy today, so the profile reports none; how one would is the owner's call ([`todo.md`](todo.md)).

## Record

Orders, workers, attempts, artifacts, evidence and the ledger live in `factory_*` tables that `dim rebuild` carries through ([`design.md`](design.md#schema)), since nothing can recreate an attempt after the fact. `dim q factory-analytics` derives retries, approval waits, outcomes and verdicts from them.

While the factory is being built, `DIM_HOME=<dir> bun run factory:reset -- --confirm-factory-reset` clears its orders in a named data directory; it refuses the default one.

## Scheduling

`dim schedule define|pause|resume` and `dim q schedules` keep interval schedules. A host — launchd, cron, a harness — only invokes `dim`; starting work from a schedule is not built ([`todo.md`](todo.md)).

## Borrowed from the assembly line

- **Stop on a defect, never on success** (*jidoka*). The commit gate halts a failing change; the operator halts on a second failure of one order.
- **Anyone may halt the line** (*andon*). A finding stops its slice until answered. A worker uses `dim factory stop --reason "..."` to stop the floor; the operator uses `dim factory clear` after resolving the defect.
- **Fix the process, not the part.** A defect found repeatedly is a gate that does not exist yet.
- **Make the error impossible** (*poka-yoke*). Whatever is mechanical is a gate; judgement goes to an agent with a fixed brief.
- **One piece at a time.** A slice is verified and committed before the next begins.
- **Go and see** (*genchi genbutsu*). A claim is verified at its source.
- **The operator does not work the line.**

Takt time does not transfer: a slice is not an interchangeable unit, and a cadence would manufacture work to fill it.
