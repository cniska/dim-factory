# dim-factory

> A local record and software factory for coding agents: it records what every Claude Code and Codex session did, brings that back when it is needed, and runs agreed work through checked, isolated stations.

- **Record.** Sessions, tool calls, commits and usage in one local SQLite database. No network, no credential, no per-token cost.
- **Recall.** Named queries and local semantic search over what was decided before; `dim wake` delivers the last handoff to a new session.
- **Gates.** Hooks that hold mechanical rules — commit subjects, the repo's check, comments, pushes to the default branch — whether or not a skill loaded.
- **Factory.** Orders run through plan, build and review stations as separate workers, each in its own worktree, with every act recorded and the owner approving each artifact.
- **Wall.** A read-only board showing where every order is.

## Quick start

```sh
mise install
bun install
bun link
dim sync
dim doctor
dim q list
```

`bun run verify` is the repository check.

## Docs

- [Using dim-factory](docs/usage.md) — install, collect, query, gates and config
- [The factory](docs/factory.md) — orders, stations, workers, ship and done
- [My workflow](docs/my-workflow.md) — the manual workflow the factory replaces
- [Todo](docs/todo.md) — what is not built
- [Everything else](docs/README.md)
