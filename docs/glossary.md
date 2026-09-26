# Glossary

One word per thing. A page that uses a word links here rather than defining it again.

## The factory

| Term | Definition |
|---|---|
| Owner | The person the factory runs for. They approve artifacts and read the wall |
| Operator | The hand that runs the line: reads the queue, delegates each station and checks what comes back. It decides which work starts and when to stop, never how the work is done |
| Worker | A hand the factory issues before any work starts, named like `nut-7` and carrying one role. Every act on an order names its worker when it is written |
| Role | What a worker is called in as: `operator`, `planner`, `builder` or `reviewer` ([`src/worker-roles.ts`](../src/worker-roles.ts)) |
| Read-only role | `planner` and `reviewer`, which may not change the tree they read |
| Worker tree | The record of who delegated to whom: the operator, its station workers, and their children |
| Tier | The capability a role needs — `light`, `standard` or `deep` — mapped to this machine's models in one file ([`src/worker-routing.ts`](../src/worker-routing.ts)) |
| Capability | What a station's work needs, named for the work rather than a harness flag — `read-files`, `edit-files`, `run-check` and the rest ([`src/worker-capabilities.ts`](../src/worker-capabilities.ts)) |
| Harness | The agent product that runs a worker session, such as Claude Code or Codex |
| Line | The kind of work an order is: `feat` (shown as **feature**) or `fix`. `dim-line-feat` and `dim-line-fix` are its entry points |
| Station | One repeatable step of work on an order: `plan`, `build` or `review` ([`src/station.ts`](../src/station.ts)). Each has a skill named `dim-station-<station>` |
| Order | One piece of work: an id, a line, a title, a description and a priority. It exists before it is started and is worked in one worktree |
| Queue | The orders not yet started, most urgent first, then oldest |
| Status | The state an order is in, read from its events: `queued`, `active` once started, `done` once shipped, or `dropped` |
| Stage | How far along an order is, as the wall shows it: `todo`, `active` or `done` |
| Next act | What an order waits on, read from the record by [`src/order-state.ts`](../src/order-state.ts) and never stored: at a station, `run` or `approve`; once every station's artifact is approved, `ship`. Every act checks it on entry |
| Slice | One increment inside an order that verifies and commits on its own |
| Ship | Landing an order's commits on the local trunk the way the repo declares in `dim.ship`, which ends the order. Approving the Review artifact ships; `dim order ship` retries a ship that failed |
| Done | The status of a shipped order: its commits are on the trunk and its worktree is gone |
| Command | One `dim` subcommand, in the `src/<name>-command.ts` named for it ([`src/cli-contract.ts`](../src/cli-contract.ts)) |
| Command line | The text a shell runs, such as `bun run verify` |
| Workspace task | What a repo declares in its manifest — a `package.json` script, a `mise` task, a `Makefile` target — read, never inferred ([`src/workspace-tasks.ts`](../src/workspace-tasks.ts)). The check is the task that says a change is sound |

## The record

| Term | Definition |
|---|---|
| Start | The first `dim order plan` on a queued order, which makes its worktree and moves it out of the queue |
| Attempt | One station hand's run on an order, from start to finish, with its outcome. A build attempt that has not finished and whose worker is not over refuses a second one ([`src/order-attempt.ts`](../src/order-attempt.ts)) |
| Drop | The owner's decision not to build an order, with the reason |
| Ledger | An order's events in `factory_order_event`, appended and never changed ([`src/order-ledger.ts`](../src/order-ledger.ts)) |
| Evidence | What an order produced: commits, changed files, checks, findings and answers |
| Artifact | A document a station worker writes for the owner — a plan, a Build artifact or a review — one row per revision in `factory_order_artifact`. It leads with the outcome and never lives in the worktree |
| Build turn | What a builder returns after code work: the commit subject, an answer per finding it was handed, and on the last turn the Build artifact ([`src/station-build-turn.ts`](../src/station-build-turn.ts)). The runner commits; the builder does not |
| Check sandbox | The confinement the runner runs a repo's check in: worktree writable, network and `dim`'s data refused ([`src/check-sandbox.ts`](../src/check-sandbox.ts)) |
| Rewrite | One rebase of an order's branch onto a moved trunk, recorded with the sha each commit retires |
| Finding | A problem a reviewer raised, with a file and line, the failure, a fix direction and a severity ([`src/order-finding-state.ts`](../src/order-finding-state.ts)) |
| Severity | How much a finding costs if it ships: `critical`, `high` or `medium` |
| Observation | A point in a review that blocks nothing |
| Answer | The builder's one reply to a finding: `fixed`, or `refused` with a resolution. A later round that still finds the problem raises a new finding |
| Gate | A rule git or `dim` refuses to let pass, whether or not anything was read |
| Comment gate | The part of the commit gate that refuses a new comment in a JS or TS file, in a repo that bans them ([`usage.md`](usage.md#comment-gate)) |
| Config | `dim`'s settings, from the user's and the project's JSON layers ([`usage.md`](usage.md#configuration)) |
| Setting | One named entry of the config, taking one of a fixed set of values |
