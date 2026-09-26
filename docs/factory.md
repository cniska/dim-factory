# The factory

The argument this repo executes, and how the factory works today. [`my-workflow.md`](my-workflow.md) is the workflow it replaces; [`goals.md`](goals.md) is what it is measured against.

## Dim, not dark

A factory with no human reading the work ships whatever the checks miss, and the checks do not catch a coherent, confident, wrong design. So:

- **Autonomous between the gates.** Once a direction is agreed, agents read, write, verify and recover without asking at every branch.
- **A human at the gates that matter.** Hard-to-reverse, outward-facing or ambiguous work waits for the owner.
- **Each gate earns its automation from a record.** Every approval and return is an attributed event, so which kinds of work stopped needing a read is a query over verdicts, not a feeling. Reviewing everything is the starting point, because a gate cannot earn its way out of a record never kept.

## The line

- **Skills are the stations.** `dim-line-feat` and `dim-line-fix` are the entry points; `dim-station-plan`, `dim-station-build` and `dim-station-review` are the stations.
- **Coding agents are the floor.** Each station runs as a worker in Claude Code or Codex.
- **`AGENTS.md` and `SPEC.md` are the tolerances.** A line cannot run unattended without them.
- **Checks, review and gates are QC.**

## An order

One piece of work, written down before anyone takes it ([`glossary.md`](glossary.md)). Its id is also its branch and its worktree, `<repo>/.claude/worktrees/<order-id>`.

```text
queued → plan → build → review → ship → completed
```

- **The operator** runs it: claims it, delegates each station to a worker, checks each artifact against the record, and advances or returns it. It never does the work.
- **Each station returns an artifact** — plan, Build artifact, Review artifact — that the operator approves (`dim order approve`) or sends back with a reason (`dim order return`).
- **Review with findings** sends the order back to build; the builder answers each finding `fixed` or `refused`, and the next round rules on the answers. The owner settles a contested refusal with `dim order rule`.
- **Ship** delivers it (see [Done](#done)).
- **A failed attempt** puts the order back in `queued`, holding nothing; **a drop** is the owner deciding it will not be built.
- **A hold** keeps an order until the owner releases it; a station artifact awaiting approval holds the order the same way.
- **One act, one path.** Findings arrive only in the reviewer's report and answers only in the builder's build turn.

### Commands

```sh
dim order add <id> --title "..." [--line feat|fix] [--description "..."]
dim order ready                          # the queue, with held orders beside it
dim order priority|hold|release|amend|drop <id> ...
dim order plan|build|review <id> [--harness codex|claude]
dim order approve <id>
dim order return <id> --reason "..."
dim order rule <finding-id> --uphold|--overturn --reason "..."
dim order ship <id>
dim q order <id>                         # one order's full record
dim q factory                            # every order's current state
dim trace <id>                           # diagnostic events, followed live
```

A command with no `--harness` runs the worker under the harness the operator's own session is in.

## The build turn

A builder leaves its changes uncommitted and returns a build turn: a commit subject, an answer per finding, and on the last turn the Build artifact. The runner then ([`src/builder-commit.ts`](../src/builder-commit.ts)):

1. refuses a turn that leaves a handed finding unanswered, answers one it was not handed, or refuses a refusal the owner overturned
2. applies the comment gate over the staged tree, reading the ban from the trunk's config so a builder cannot lift it
3. runs the repo's check in the check sandbox, without the operator's identity
4. commits with the repo's own identity and signing, and records the commit under the builder and the check under the operator

A refused commit or comment goes back to the same builder, at most twice per turn. A red check, a check that changed the tree, a nested repository, or HEAD moved off the order's branch fails the turn, and the reason is in the next turn's brief.

## Done

An order is done when its check passed on the final commit, every finding was answered, the docs changed with the behavior, its commits are on the trunk, and its worktree is gone. The record can hold two of those mechanically — the check and the trunk — and refuses completion without them; the rest rest on the stations.

`dim order ship <id>` lands it the way the repo declares with `git config dim.ship`:

- **`trunk`** fast-forwards the trunk to the order's branch. A branch the trunk has moved past is first rebased in the order's worktree and re-checked; a red check undoes the rebase.
- **`pull-request`** is declared but not built, and refused.
- A repo that declares nothing, or an unknown value, is refused, so no agent guesses how a repo ships.

Around it:

- The trunk is `refs/remotes/origin/HEAD`, never an assumed name.
- Ship runs under the factory lock, since two ships would race on one checkout.
- A rebase that changed a patch sends the order back to review, reading the whole order from the new base. A conflict sends it back to build: the builder resolves the paths in place, and the runner continues the rebase instead of committing ([`src/rebase-turn.ts`](../src/rebase-turn.ts)).
- A rebase is recorded as a rewrite: each retired sha stays in the record and never counts as landed, reviewed or current.
- Refused before anything moves: a dirty or nested worktree, a dirty trunk, a branch tip that is none of the order's recorded commits, and an unsigned commit where the repo signs.

## Workers

- **Every act names its worker** when it is written, and nothing is attributed afterwards. A runner failure before a worker exists names no worker rather than blaming the operator.
- **The operator** is resolved by `dim operator` from the active session in this checkout's `owner/repo`, and keeps one credential for its session.
- **Station workers** are issued through assignments. One worker per station per order keeps its provider session, so later turns resume it with its context. A worker bound to one harness is refused under another.
- **A worker is over when its process stops answering** a signal ([`src/factory-worker.ts`](../src/factory-worker.ts)); nothing needs to be awake to notice.
- **A worker is started without the operator's identity** or session, and without an API key, so it is never billed per token. A Claude worker cannot start background work.
- **Sandboxes.** No worker gets the checkout's git metadata. Codex builders run `workspace-write`, everything else read-only; Claude workers run in its Bash sandbox with `.git` denied.

## Roles and tiers

Each role runs at a tier declared in [`src/routing.ts`](../src/routing.ts): the planner, the reviewer and the operator at `deep`, the builder at `standard`. The machine's `routing.json` maps each harness's models to the tiers, and `dim route` refuses a map that does not say exactly one thing. No model name appears in this repo.

A station asks for capabilities, never a harness's flags ([`src/capabilities.ts`](../src/capabilities.ts)); each harness adapter maps them ([`src/codex-harness.ts`](../src/codex-harness.ts), [`src/claude-harness.ts`](../src/claude-harness.ts)).

## Worker environments

- The workspace profile ([`src/workspace.ts`](../src/workspace.ts)) names the checkout's languages, package managers, workspace members, tasks, compose services and the variable names a sample env file declares — never a value.
- The repository's setup and teardown hooks own every side effect ([`worktrees.md`](worktrees.md)); `dim` records what they report against the order.
- A repository states no isolation strategy today, so the profile reports none; how one would is the owner's call ([`todo.md`](todo.md)).

## Record

Orders, workers, attempts, artifacts, evidence and the ledger live in the `factory_*` tables and survive `dim rebuild`, since nothing can recreate a claim after the fact. `dim q factory-analytics` derives retries, holds, outcomes and verdicts from them.

While the factory is being built, `DIM_HOME=<dir> bun run factory:reset -- --confirm-factory-reset` clears its orders in a named data directory; it refuses the default one.

## Scheduling

`dim schedule define|pause|resume` and `dim q schedules` keep interval schedules. A host — launchd, cron, a harness — only invokes `dim`; claiming work from a schedule is not built ([`todo.md`](todo.md)).

## Borrowed from the assembly line

- **Stop on a defect, never on success** (*jidoka*). The commit gate halts a failing change; the operator halts on a second failure of one order.
- **Anyone may halt the line** (*andon*). A finding stops its slice until answered. `dim factory stop` stops the floor.
- **Fix the process, not the part.** A defect found repeatedly is a gate that does not exist yet.
- **Make the error impossible** (*poka-yoke*). Whatever is mechanical is a gate; judgement goes to an agent with a fixed brief.
- **One piece at a time.** A slice is verified and committed before the next begins.
- **Go and see** (*genchi genbutsu*). A claim is verified at its source.
- **The operator does not work the line.**

Takt time does not transfer: a slice is not an interchangeable unit, and a cadence would manufacture work to fill it.
