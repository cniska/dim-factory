# dim-factory

> A local memory and software factory for coding agents: it records what sessions did, recovers prior context, and runs agreed work through isolated, checked stages.

## What it provides

- **Memory.** Claude Code and Codex sessions, tool calls, commits and usage are ingested into one local SQLite database.
- **Recall.** Named queries and semantic search recover prior decisions, context and repository history without a network call.
- **A factory line.** `dim-factory` reads a repository queue and routes work through the `dim-line-feat` and `dim-line-fix` entry points. Those entry points use the `dim-station-plan`, `dim-station-build` and `dim-station-review` stations.
- **Evidence.** Reports, lifecycle events, checks, findings and changed files are persisted so work can be inspected after the session ends.
- **Gates.** Hooks hold mechanical rules for commits, pushes, collection and session context.
- **Isolation.** `dim wt` gives each task its own worktree and branch.

The session database, query CLI, hooks, worktrees, stations and factory report tables are live. The queue planner, self-sufficient driver and unified factory status view are being built. The design and current build order are in [`docs/`](docs/README.md).

## Quick start

```sh
mise install
bun install
bun link
dim sync
dim doctor
dim q list
```

Run the repository check with:

```sh
bun run verify
```

## Learn more

- [Using dim-factory](docs/usage.md) — installation, collection, queries, hooks, worktrees and stations
- [Source layout](src/README.md) — module groups and where to start reading the code
- [The factory](docs/factory.md) — line, job, report and queue design
- [Session database](docs/design.md) — sources, schema and read path
- [Reaching a session without being asked](docs/recall.md) — wake, handoffs and retrieval
- [Worktrees](docs/worktrees.md) — isolated checkouts and write recovery
- [Build order](docs/build-order.md) — what is next and what each item waits on
- [Findings](docs/findings.md) — measured observations and their limits
