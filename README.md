# dim-factory

dim is a local CLI for coding agents. It records Claude Code and Codex sessions, lets agents recall earlier work, and runs agreed work through checked, isolated stations. The owner requests work through an agent and reads the factory's artifacts; the agent uses `dim` to operate the record and the factory.

- **Record.** Sessions, tool calls, commits and usage in one local SQLite database. No network, no credential, no per-token cost.
- **Recall.** Named queries and local semantic search over what was decided before; `dim wake` delivers the last handoff to a new session.
- **Gates.** Hooks that hold mechanical rules — commit subjects, the repo's check, comments, pushes to the default branch — whether or not a skill loaded.
- **Factory.** Orders run through plan, build and review stations as separate workers in the order's worktree, with every act recorded and the owner approving each artifact.
- **Wall.** A read-only board showing where every order is.

## Agent setup

These commands set up dim in the agent's environment:

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

- [Agent command reference](docs/usage.md) — install, collect, query, gates and config
- [The factory](docs/factory.md) — orders, stations, workers, ship and done
- [My workflow](docs/my-workflow.md) — the manual workflow the factory replaces
- [Todo](docs/todo.md) — what is not built
- [Everything else](docs/README.md)
